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
    sync_jobs: 'yaml text,error text,target_repository text,target_branch text,commit_sha text,record_id uuid,github_grant_id uuid,github_owner_id uuid,github_connection_id uuid,github_installation_id text,github_repository_id text,github_allow_public boolean',
    block_categories: 'id uuid,slug text,name text,name_key text,icon text',
    settings: 'key text,value jsonb', ai_quota_config: 'value jsonb', image_storage_config: 'value jsonb',
    document_storage_config: 'value jsonb', users: 'email text,password_hash text,role text,display_name text',
    project_members: 'project_id uuid,user_id uuid,role text', user_sessions: 'id uuid,user_id uuid',
    image_references: 'image_id uuid,resource_kind text,resource_id uuid',
    pending_registrations: 'email text,token_hash text,language text',
    mfa_credentials: "secret_box jsonb,pending_box jsonb,recovery_hashes text[] NOT NULL DEFAULT '{}',challenge_hash text",
    github_links: 'id uuid', github_oauth_states: 'id uuid', github_project_grants: 'id uuid',
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
  await configure({ platformBytes: 1_000_000, aiBytes: 1_000_000, userAiBytes: 12, syncBytes: 1_000_000, projectSyncBytes: 1027, categoryBytes: 8 })
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
  // MFA is bounded per account and must not lock recovery out at full capacity.
  const beforeMfa = (await storage.configuration()).usage.config
  await scoped('INSERT INTO mfa_credentials(secret_box,recovery_hashes) VALUES($1,$2)', [{ v: 1, data: 'synthetic-ciphertext' }, ['a'.repeat(64)]])
  const duringMfa = (await storage.configuration()).usage.config
  assert.ok(BigInt(duringMfa) > BigInt(beforeMfa) + 256n)
  assert.equal(duringMfa, (await q(usageSql)).rows[0].config)
  await scoped('UPDATE mfa_credentials SET recovery_hashes=ARRAY[]::text[],challenge_hash=$1', ['b'.repeat(64)])
  assert.equal((await storage.configuration()).usage.config, (await q(usageSql)).rows[0].config)
  await scoped('DELETE FROM mfa_credentials')
  assert.equal((await storage.configuration()).usage.config, beforeMfa)
  await assert.rejects(scoped('INSERT INTO project_members VALUES($1,$2,$3)', [crypto.randomUUID(),crypto.randomUUID(),'reader']), { code: 'PZ001' })
  // GitHub reserves both bounded credential/state slots BEFORE OAuth. Once
  // admitted, token refresh/settlement does not grow usage even at a closed cap.
  const beforeGithub = (await storage.configuration()).usage.config
  await assert.rejects(scoped('INSERT INTO github_project_grants VALUES($1)', [crypto.randomUUID()]), { code: 'PZ001' })
  await assert.rejects(scoped('INSERT INTO github_links VALUES($1)', [crypto.randomUUID()]), { code: 'PZ001' })
  await configure({ configBytes: Number(beforeGithub) + 10240, platformBytes: 1_000_000 })
  await scoped('INSERT INTO github_links VALUES($1)', [crypto.randomUUID()])
  await scoped('INSERT INTO github_oauth_states VALUES($1)', [crypto.randomUUID()])
  assert.equal((await storage.configuration()).usage.config, String(BigInt(beforeGithub) + 10240n))
  await configure({ configBytes: 0, platformBytes: 0 })
  await scoped('UPDATE github_links SET id=$1', [crypto.randomUUID()])
  await scoped('DELETE FROM github_oauth_states')
  await scoped('DELETE FROM github_links')
  assert.equal((await storage.configuration()).usage.config, beforeGithub)
  await configure({ platformBytes: 1_000_000 })
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
  // A GitHub job reserves outcome/capability metadata before a remote commit;
  // success/error settlement cannot grow storage at a newly closed cap.
  const syncAdmitted = (await storage.configuration()).usage
  await configure({ platformBytes: 0, syncBytes: 0, projectSyncBytes: 0 })
  await scoped("UPDATE sync_jobs SET error='GITHUB_ACCESS_DENIED',commit_sha=$1,github_grant_id=$2 WHERE record_id=$3", ['a'.repeat(40),crypto.randomUUID(),project])
  assert.deepEqual((await storage.configuration()).usage,syncAdmitted)
  // Connection tests have no payload reservation: reserve status growth upfront.
  const beforeCall = await storage.configuration(), connectionActor = crypto.randomUUID()
  await configure({ platformBytes: Number(beforeCall.usage.total) + 10, aiBytes: Number(beforeCall.usage.ai) + 10, userAiBytes: 1_000_000 })
  await scoped('INSERT INTO ai_calls VALUES($1,$2,$3,0)', ['r','reserved',connectionActor])
  const admitted = (await storage.configuration()).usage
  assert.equal(admitted.total, String(BigInt(beforeCall.usage.total) + 10n))
  await configure({ platformBytes: 0, aiBytes: 0, userAiBytes: 0 })
  await scoped("UPDATE ai_calls SET status='succeeded' WHERE user_id=$1", [connectionActor])
  assert.deepEqual((await storage.configuration()).usage, admitted)
  const final = await storage.configuration(), measured = (await q(usageSql)).rows[0]
  for (const field of ['images','documents','ai','sync','categories','config']) assert.equal(final.usage[field], measured[field])
})
