import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import pg from 'pg'
import { createReadiness,databaseProbe } from './readiness.js'
import { defaultImageStorage } from '../images/quotas.js'
import { defaultDocumentStorage } from '../document-storage/config.js'
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
  await q('CREATE TABLE ai_calls(storage_bytes bigint NOT NULL DEFAULT 0)')
  await ready(true)
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
