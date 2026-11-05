import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { initTotalStorage, usageSql } from './migration.js'
import { createTotalStorage } from './service.js'

const url = process.env.API_TEST_DATABASE_URL
test('total logical quota serializes writers and rolls back over-budget transactions', { skip: !url }, async t => {
  const root = new pg.Pool({ connectionString: url })
  if (!(await root.query("SELECT 1 FROM pg_roles WHERE rolname='sugar_runtime'")).rowCount) { await root.end(); t.skip('disposable runtime role not provisioned'); return }
  const schema = 'total_storage_' + crypto.randomBytes(8).toString('hex')
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  const definitions = {
    images: 'name text,mime text,data bytea', projects: 'name text,yaml text', blocks: 'name text',
    project_revisions: 'yaml text,summary text', block_versions: 'yaml text,summary text',
    project_settings_history: 'before jsonb,after jsonb',
    project_analyses: 'snapshot jsonb,response text,focus text,model text,usage jsonb,author_id uuid',
    ai_calls: 'payload_hash text,status text,user_id uuid,storage_bytes bigint NOT NULL DEFAULT 0',
    sync_jobs: 'yaml text,error text,target_repository text,target_branch text,commit_sha text,record_id uuid',
    block_categories: 'id uuid,slug text,name text,name_key text,icon text',
    settings: 'key text,value jsonb', ai_quota_config: 'value jsonb', image_storage_config: 'value jsonb',
    document_storage_config: 'value jsonb', users: 'email text,password_hash text,role text',
    project_members: 'project_id uuid,user_id uuid,role text', user_sessions: 'id uuid,user_id uuid',
    image_references: 'image_id uuid,resource_kind text,resource_id uuid',
    pending_registrations: 'email text,token_hash text,language text',
    account_actions: 'kind text,email text,token_hash text,old_token_hash text,old_email text,user_id uuid,language text',
  }
  for (const [table, columns] of Object.entries(definitions)) await q(`CREATE TABLE ${table}(${columns})`)
  const transaction = async fn => { const client = await db.connect(); try { await client.query('BEGIN'); const result = await fn((sql, args) => client.query(sql, args)); await client.query('COMMIT'); return result } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() } }
  await initTotalStorage(q, transaction); await initTotalStorage(q, transaction)
  await root.query(`GRANT USAGE ON SCHEMA ${schema} TO sugar_runtime`)
  await q('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ' + schema + ' TO sugar_runtime')
  const storage = createTotalStorage({ q, transaction })
  const first = await storage.configuration(); assert.equal(first.usage.total, '0')
  await assert.rejects(storage.configure({ ...first, expectedVersion: 0 }), { status: 400 })
  const exact = await storage.configure({ ...Object.fromEntries(Object.keys(first).filter(key => !['version','usage'].includes(key)).map(key => [key, first[key]])), categoryBytes: 6, expectedVersion: first.version })
  assert.equal(exact.categoryBytes, 6)
  const writer = async slug => {
    const client = await db.connect()
    try { await client.query('SET ROLE sugar_runtime'); await client.query('INSERT INTO block_categories VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),slug,'A','a','a']); return 'ok' }
    finally { await client.query('RESET ROLE'); client.release() }
  }
  const results = await Promise.allSettled([writer('a'), writer('b')])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'PZ001').length, 1)
  assert.equal((await q('SELECT count(*)::int AS n FROM block_categories')).rows[0].n, 1)
  const usage = (await q(usageSql)).rows[0]
  assert.equal(Number(usage.categories), 4)
  assert.equal((await storage.configuration()).usage.categories, usage.categories)
  const config = await storage.configuration()
  await storage.configure({ ...Object.fromEntries(Object.keys(config).filter(key => !['version','usage'].includes(key)).map(key => [key, config[key]])), platformBytes: Number(config.usage.total), expectedVersion: config.version })
  await assert.rejects(writer('c'), { code: 'PZ001' })
  assert.equal((await q('SELECT count(*)::int AS n FROM block_categories')).rows[0].n, 1)
  const configure = async changes => {
    const current = await storage.configuration()
    return storage.configure({ ...Object.fromEntries(Object.keys(current).filter(key => !['version','usage'].includes(key)).map(key => [key, current[key]])), ...changes, expectedVersion: current.version })
  }
  await configure({ platformBytes: 1_000_000, aiBytes: 1_000_000, userAiBytes: 5, syncBytes: 1_000_000, projectSyncBytes: 3, categoryBytes: 8 })
  const rollback = await db.connect()
  try {
    await rollback.query('SET ROLE sugar_runtime')
    await rollback.query('BEGIN')
    await rollback.query('INSERT INTO block_categories VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),'x','A','a','a'])
    await rollback.query('INSERT INTO block_categories VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),'y','A','a','a'])
    // Deferred admission: the whole transaction is judged and rolled back at COMMIT.
    await assert.rejects(rollback.query('COMMIT'), { code: 'PZ001' })
  } finally { await rollback.query('RESET ROLE'); rollback.release() }
  assert.equal((await q('SELECT count(*)::int AS n FROM block_categories')).rows[0].n, 1)
  assert.equal((await storage.configuration()).usage.categories, '4')
  const actor = crypto.randomUUID(), project = crypto.randomUUID()
  async function scoped(sql, args) {
    const client = await db.connect()
    try { await client.query('SET ROLE sugar_runtime'); await client.query(sql, args) }
    finally { await client.query('RESET ROLE'); client.release() }
  }
  let races = await Promise.allSettled([scoped('INSERT INTO ai_calls VALUES($1,$2,$3)', ['abc','ok',actor]), scoped('INSERT INTO ai_calls VALUES($1,$2,$3)', ['def','ok',actor])])
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(races.filter(result => result.status === 'rejected' && result.reason.code === 'PZ001').length, 1)
  const member = [crypto.randomUUID(),crypto.randomUUID(),'reader']
  const beforeMember = (await storage.configuration()).usage.config
  await scoped('INSERT INTO project_members VALUES($1,$2,$3)', member)
  assert.ok(BigInt((await storage.configuration()).usage.config) > BigInt(beforeMember))
  await scoped('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', member.slice(0,2))
  assert.equal((await storage.configuration()).usage.config, beforeMember)
  // AI reservations are admitted before provider calls; settling an analysis never fails.
  await configure({ userAiBytes: 1_000 })
  const reserved = crypto.randomUUID()
  await assert.rejects(scoped('INSERT INTO ai_calls VALUES($1,$2,$3,$4)', ['r','ok',reserved,2_000]), { code: 'PZ001' })
  await scoped('INSERT INTO ai_calls VALUES($1,$2,$3,$4)', ['r','ok',reserved,900])
  await scoped("INSERT INTO project_analyses(snapshot,response,focus,model,author_id) VALUES('{}'::jsonb,$1,'f','m',$2)", ['x'.repeat(800), reserved])
  await scoped('UPDATE ai_calls SET storage_bytes=0 WHERE user_id=$1', [reserved])
  // Sign-in continuity: sessions are counted even when configuration capacity is closed.
  await configure({ configBytes: 0 })
  const before = BigInt((await storage.configuration()).usage.config)
  await scoped('INSERT INTO user_sessions VALUES($1,$2)', [crypto.randomUUID(), crypto.randomUUID()])
  assert.ok(BigInt((await storage.configuration()).usage.config) > before)
  await assert.rejects(scoped('INSERT INTO project_members VALUES($1,$2,$3)', [crypto.randomUUID(),crypto.randomUUID(),'reader']), { code: 'PZ001' })
  // Maintenance writes are counted but not rejected.
  await q('INSERT INTO project_members VALUES($1,$2,$3)', [crypto.randomUUID(),crypto.randomUUID(),'reader'])
  await configure({ configBytes: 1_000_000, categoryBytes: 1_000_000 })
  // Writers that lock after writing cannot deadlock on the shared counter row.
  const ordered = async (first, slug) => {
    const client = await db.connect()
    try {
      await client.query('SET ROLE sugar_runtime'); await client.query('BEGIN')
      if (first) { await client.query('INSERT INTO block_categories VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),slug,'A','a','a']); await new Promise(resolve => setTimeout(resolve, 100)); await client.query("SELECT pg_advisory_xact_lock(hashtext('sugar:test-order'))") }
      else { await client.query("SELECT pg_advisory_xact_lock(hashtext('sugar:test-order'))"); await new Promise(resolve => setTimeout(resolve, 50)); await client.query('INSERT INTO block_categories VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),slug,'A','a','a']) }
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { await client.query('RESET ROLE'); client.release() }
  }
  const lockResults = await Promise.allSettled([ordered(true, 'order-a'), ordered(false, 'order-b')])
  assert.deepEqual(lockResults.map(result => result.status === 'rejected' ? result.reason.code : 'ok'), ['ok','ok'])
  races = await Promise.allSettled([scoped('INSERT INTO sync_jobs(yaml,record_id) VALUES($1,$2)', ['abc',project]), scoped('INSERT INTO sync_jobs(yaml,record_id) VALUES($1,$2)', ['def',project])])
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(races.filter(result => result.status === 'rejected' && result.reason.code === 'PZ001').length, 1)
  const final = await storage.configuration(), measured = (await q(usageSql)).rows[0]
  for (const field of ['images','documents','ai','sync','categories','config']) assert.equal(final.usage[field], measured[field])
})
