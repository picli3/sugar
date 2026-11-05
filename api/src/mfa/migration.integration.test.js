import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { initMfaDb } from './migration.js'
import { createSecretBox } from './secrets.js'
import { generateRecoveryCodes } from './recovery.js'

const url = process.env.API_TEST_DATABASE_URL
test('MFA migration bounds encrypted state and recovery material without changing existing accounts', { skip: !url }, async t => {
  const schema = 'mfa_schema_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text NOT NULL,auth_version integer NOT NULL DEFAULT 0)')
  const id = crypto.randomUUID(), other = crypto.randomUUID(), secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  await q('INSERT INTO users(id,email) VALUES($1,$2),($3,$4)', [id, 'synthetic@example.invalid', other, 'other@example.invalid'])
  const before = (await q('SELECT * FROM users ORDER BY id')).rows
  await initMfaDb(q); await initMfaDb(q)
  assert.deepEqual((await q('SELECT * FROM users ORDER BY id')).rows, before)
  assert.equal((await q('SELECT count(*)::int AS n FROM mfa_credentials')).rows[0].n, 0)
  await q('INSERT INTO mfa_credentials(user_id) VALUES($1)', [id])
  const row = (await q('SELECT * FROM mfa_credentials WHERE user_id=$1', [id])).rows[0]
  assert.equal(row.enabled, false); assert.equal(row.last_step, '-1'); assert.equal(row.failures, 0)
  assert.deepEqual(row.recovery_hashes, []); assert.equal(row.secret_box, null)
  const box = createSecretBox('05'.repeat(32)).encrypt(id, secret), codes = generateRecoveryCodes(id)
  async function invalid(sql, args = []) { await assert.rejects(q(sql, args), { code: '23514' }) }
  await assert.rejects(q('INSERT INTO mfa_credentials(user_id) VALUES($1)', [id]), { code: '23505' })
  await assert.rejects(q('INSERT INTO mfa_credentials(user_id) VALUES($1)', [crypto.randomUUID()]), { code: '23503' })
  await invalid('UPDATE mfa_credentials SET enabled=true')
  await invalid('UPDATE mfa_credentials SET secret_box=$1', [box])
  for (const invalidBox of [secret, { ...box, v: 2 }, { ...box, extra: 'x' }, { ...box, iv: '0'.repeat(25) }, { ...box, tag: null }, { ...box, data: '0'.repeat(65) }]) {
    await invalid('UPDATE mfa_credentials SET enabled=true,secret_box=$1', [JSON.stringify(invalidBox)])
  }
  for (const invalidHashes of [[codes.hashes[0]], Array(11).fill(codes.hashes[0]), ['bad'], [null]]) {
    // Disabled accounts may not retain recovery codes, even if otherwise valid.
    await invalid('UPDATE mfa_credentials SET recovery_hashes=$1', [invalidHashes])
  }
  for (const invalidHashes of [Array(11).fill(codes.hashes[0]), [codes.hashes[0], codes.hashes[0]], ['bad'], [null]]) {
    await invalid('UPDATE mfa_credentials SET enabled=true,secret_box=$1,recovery_hashes=$2', [box, invalidHashes])
  }
  await invalid('UPDATE mfa_credentials SET enabled=true,secret_box=$1,recovery_hashes=ARRAY[ARRAY[$2],ARRAY[$3]]', [box, codes.hashes[0], codes.hashes[1]])
  for (const update of ['failures=-1','failures=6','last_step=-2','pending_id=gen_random_uuid()',"challenge_hash=repeat('a',64)"])
    await invalid('UPDATE mfa_credentials SET ' + update)
  // NULL auth versions must not slip through SQL CHECK three-valued logic.
  await invalid("UPDATE mfa_credentials SET pending_box=$1,pending_id=$2,pending_expires_at=now()+interval '10 minutes'", [box, crypto.randomUUID()])
  const pending = crypto.randomUUID()
  await q("UPDATE mfa_credentials SET pending_box=$1,pending_id=$2,pending_expires_at=now()+interval '10 minutes',pending_auth_version=0", [box, pending])
  await initMfaDb(q)
  assert.equal((await q('SELECT pending_id FROM mfa_credentials')).rows[0].pending_id, pending)
  await invalid('UPDATE mfa_credentials SET enabled=true,secret_box=$1', [box])
  await q('UPDATE mfa_credentials SET enabled=true,secret_box=$1,recovery_hashes=$2,last_step=42,pending_box=NULL,pending_id=NULL,pending_expires_at=NULL,pending_auth_version=NULL', [box, codes.hashes])
  await invalid("UPDATE mfa_credentials SET challenge_hash=repeat('a',64),challenge_expires_at=now()+interval '5 minutes'")
  await q("UPDATE mfa_credentials SET challenge_hash=repeat('a',64),challenge_expires_at=now()+interval '5 minutes',challenge_auth_version=0,failures=5")
  const persisted = (await q('SELECT * FROM mfa_credentials WHERE user_id=$1', [id])).rows[0], text = JSON.stringify(persisted)
  assert.equal(text.includes(secret), false)
  for (const code of codes.codes) assert.equal(text.includes(code), false)
  assert.deepEqual(persisted.recovery_hashes, codes.hashes)
  await q("INSERT INTO mfa_credentials(user_id,enabled,secret_box,challenge_hash,challenge_expires_at,challenge_auth_version) VALUES($1,true,$2,repeat('b',64),now()+interval '5 minutes',0)", [other, createSecretBox('05'.repeat(32)).encrypt(other, secret)])
  await assert.rejects(q("UPDATE mfa_credentials SET challenge_hash=repeat('a',64) WHERE user_id=$1", [other]), { code: '23505' })
  // Rerunning migrations preserves counters, ciphertext, watermarks and recovery hashes.
  await initMfaDb(q)
  assert.deepEqual((await q('SELECT * FROM mfa_credentials WHERE user_id=$1', [id])).rows[0], persisted)
  await invalid('UPDATE mfa_credentials SET enabled=false WHERE user_id=$1', [id])
  await q('DELETE FROM users WHERE id=$1', [id])
  assert.equal((await q('SELECT count(*)::int AS n FROM mfa_credentials WHERE user_id=$1', [id])).rows[0].n, 0)
  assert.equal((await q('SELECT count(*)::int AS n FROM mfa_credentials')).rows[0].n, 1)
})
