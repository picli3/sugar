import { initMfaDb } from '../mfa/migration.js'
import { initMfaSessionDb } from '../mfa/session-migration.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import pg from 'pg'
import { createReadiness,databaseProbe } from './readiness.js'
import { defaultImageStorage } from '../images/quotas.js'
import { defaultDocumentStorage } from '../document-storage/config.js'
import { defaultTotalStorage } from '../storage-total/config.js'
import { initTotalStorage } from '../storage-total/migration.js'
import { createTransaction } from '../db.js'
const url=process.env.API_TEST_DATABASE_URL
test('quota readiness fails closed on old/missing/corrupt schemas and recovers without rewriting data', {skip:!url},async t=>{
  const schema='quota_readiness_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url})
  await admin.query('CREATE SCHEMA '+schema)
  const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema}),q=(sql,args)=>pool.query(sql,args)
  t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()})
  const check=createReadiness({probe:databaseProbe(q),cacheMs:0}),ready=async expected=>{assert.equal(await check(),expected);await tick()}
  await q('CREATE TABLE settings(key text PRIMARY KEY,value jsonb)');await q("INSERT INTO settings VALUES('schema_version','1')")
  await ready(false)
  await q('CREATE TABLE image_storage_config(id boolean PRIMARY KEY,value jsonb,version int)')
  await q('CREATE TABLE document_storage_config(id boolean PRIMARY KEY,value jsonb,version int)')
  await ready(false)
  await q('INSERT INTO image_storage_config VALUES(true,$1,1)',[JSON.stringify(defaultImageStorage)])
  await q('INSERT INTO document_storage_config VALUES(true,$1,1)',[JSON.stringify(defaultDocumentStorage)])
  await ready(false)
  await q('CREATE TABLE ai_calls(payload_hash text,status text,user_id uuid,storage_bytes bigint NOT NULL DEFAULT 0)')
  await ready(false)
  // Remaining tables counted by the total storage guard (settings and quota configs already exist).
  for (const [table, columns] of Object.entries({
    images: 'name text,mime text,data bytea', projects: 'name text,yaml text', blocks: 'name text',
    project_revisions: 'yaml text,summary text', block_versions: 'yaml text,summary text', project_settings_history: 'before jsonb,after jsonb',
    project_analyses: 'snapshot jsonb,response text,focus text,model text,usage jsonb,author_id uuid',
    sync_jobs: 'yaml text,error text,target_repository text,target_branch text,commit_sha text,record_id uuid',
    block_categories: 'slug text,name text,name_key text,icon text', ai_quota_config: 'value jsonb',
    users: 'id uuid PRIMARY KEY,email text,password_hash text,role text', project_members: 'project_id uuid,user_id uuid,role text',
    user_sessions: 'id uuid,user_id uuid', image_references: 'image_id uuid,resource_kind text,resource_id uuid',
    pending_registrations: 'email text,token_hash text,language text',
    account_actions: 'kind text,email text,token_hash text,old_token_hash text,old_email text,user_id uuid,language text',
  })) await q(`CREATE TABLE ${table}(${columns})`)
  await ready(false)
  await initMfaDb(q); await initMfaSessionDb(q)
  const migrateTotal = () => initTotalStorage(q, createTransaction(pool))
  await migrateTotal(); await ready(true)
  await q('ALTER TABLE user_sessions DISABLE TRIGGER sugar_mfa_session_guard');await ready(false)
  await q('ALTER TABLE user_sessions ENABLE TRIGGER sugar_mfa_session_guard');await ready(true)
  await q('ALTER TABLE user_sessions ALTER COLUMN mfa_verified DROP NOT NULL');await ready(false)
  await q('ALTER TABLE user_sessions ALTER COLUMN mfa_verified SET NOT NULL');await ready(true)
  await q('DROP TRIGGER sugar_total_storage_images ON images');await ready(false)
  await migrateTotal(); await ready(true)
  await q('ALTER TABLE users DISABLE TRIGGER sugar_total_storage_users');await ready(false)
  await q('ALTER TABLE users ENABLE TRIGGER sugar_total_storage_users');await ready(true)
  await q('UPDATE total_storage_config SET value=$1',[JSON.stringify({...defaultTotalStorage,aiBytes:-1})]);await ready(false)
  await q('UPDATE total_storage_config SET value=$1',[JSON.stringify(defaultTotalStorage)]);await ready(true)
  await q('DELETE FROM total_storage_usage');await ready(false)
  await migrateTotal(); await ready(true)
  await q('ALTER TABLE ai_calls ALTER COLUMN storage_bytes DROP NOT NULL');await ready(false)
  await q('ALTER TABLE ai_calls ALTER COLUMN storage_bytes SET NOT NULL');await ready(true)
  await q('ALTER TABLE ai_calls ALTER COLUMN storage_bytes TYPE text');await ready(false)
  await q('ALTER TABLE ai_calls ALTER COLUMN storage_bytes DROP DEFAULT')
  await q('ALTER TABLE ai_calls ALTER COLUMN storage_bytes TYPE bigint USING storage_bytes::bigint');await ready(true)
  await q('UPDATE document_storage_config SET version=0');await ready(false)
  await q('UPDATE document_storage_config SET version=1');await ready(true)
  await q('UPDATE image_storage_config SET value=$1',[JSON.stringify({...defaultImageStorage,userFiles:'bad'})]);await ready(false)
  await q('UPDATE image_storage_config SET value=$1',[JSON.stringify(defaultImageStorage)]);await ready(true)
  await q('ALTER TABLE document_storage_config DROP COLUMN version');await ready(false)
  await q('ALTER TABLE document_storage_config ADD COLUMN version int DEFAULT 1');await ready(true)
  await q("UPDATE settings SET value='2'");await ready(false)
  await q("UPDATE settings SET value='1'");await ready(true)
  assert.deepEqual((await q('SELECT value FROM image_storage_config')).rows[0].value,defaultImageStorage)
})
