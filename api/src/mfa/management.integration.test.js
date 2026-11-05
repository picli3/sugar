import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { initSessionDb, createSessionRepository } from '../auth/sessions.js'
import { createMfaChallenges } from './challenges.js'
import { createMfaManagement } from './management.js'
import { createSecretBox } from './secrets.js'
import { generateSecret } from './totp.js'
import { generateRecoveryCodes } from './recovery.js'

const url = process.env.API_TEST_DATABASE_URL
test('MFA regeneration and disabling require current password/session/factor and atomically invalidate other sessions', { skip: !url }, async t => {
  const schema = 'mfa_manage_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,email text,role text DEFAULT 'Admin',language text DEFAULT 'es',theme text DEFAULT 'light',active boolean DEFAULT true,password_hash text)`)
  await initSessionDb(q)
  const transaction = createTransaction(db), sessions = createSessionRepository(q, transaction), box = createSecretBox('08'.repeat(32)), noKey = createSecretBox(undefined)
  const id = crypto.randomUUID(), other = crypto.randomUUID(), sid = crypto.randomUUID(), copy = crypto.randomUUID(), otherSid = crypto.randomUUID(), hash = 'synthetic-rechecked-password-hash', codes = generateRecoveryCodes(id)
  await q('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)', [id, 'manage@example.invalid', hash, other, 'other@example.invalid'])
  await q('INSERT INTO mfa_credentials(user_id,enabled,secret_box,recovery_hashes) VALUES($1,true,$2,$3)', [id, box.encrypt(id, generateSecret()), codes.hashes])
  const expires = new Date(Date.now() + 60 * 60 * 1000)
  // Synthetic enrolled fixtures; real activation/proof callbacks are tested separately.
  for (const value of [sid, copy]) await q('INSERT INTO user_sessions(id,user_id,auth_version,expires_at,mfa_verified) VALUES($1,$2,0,$3,true)', [value, id, expires])
  assert.equal(await sessions.create(otherSid, other, hash, expires), true)
  const state = async () => (await q('SELECT * FROM mfa_credentials WHERE user_id=$1', [id])).rows[0]
  const version = async () => (await q('SELECT auth_version FROM users WHERE id=$1', [id])).rows[0].auth_version
  const management = createMfaManagement({ transaction, secretBox: box }), recoveryOnly = createMfaManagement({ transaction, secretBox: noKey }), challenges = createMfaChallenges({ transaction, secretBox: box })
  const input = { userId: id, sessionId: sid, expectedHash: hash, recovery: true, code: codes.codes[0] }
  await assert.rejects(management.regenerate({ ...input, sessionId: otherSid }), { status: 401 })
  await assert.rejects(management.disable({ ...input, expectedHash: 'stale-hash' }), { status: 401 })
  assert.equal((await state()).failures, 0)
  for (let i = 1; i <= 5; i++) {
    await assert.rejects((i % 2 ? management : recoveryOnly).regenerate({ ...input, code: 'invalid' }), { status: i === 5 ? 429 : 401 })
    assert.equal((await state()).failures, i)
  }
  await assert.rejects(management.disable(input), { status: 429 })
  await assert.rejects(challenges.issue(id, hash), { status: 429 })
  await q("UPDATE mfa_credentials SET failures_since=now()-interval '16 minutes' WHERE user_id=$1", [id])
  const staleChallenge = await challenges.issue(id, hash), beforeMissing = await state()
  await assert.rejects(recoveryOnly.regenerate({ ...input, recovery: false, code: '000000' }), { status: 503, message: 'mfaKeyMissing' })
  assert.deepEqual(await state(), beforeMissing)
  const fresh = await recoveryOnly.regenerate(input)
  assert.equal(fresh.recoveryCodes.length, 10)
  const regenerated = await state()
  assert.equal(regenerated.enabled, true); assert.equal(regenerated.challenge_hash, null)
  assert.equal(regenerated.failures, 0); assert.equal(await version(), 1)
  assert.equal(regenerated.secret_box.data, beforeMissing.secret_box.data)
  for (const value of [...codes.hashes, ...fresh.recoveryCodes]) assert.equal(JSON.stringify(regenerated).includes(value), false)
  assert.ok(await sessions.user(sid, id)); assert.equal(await sessions.user(copy, id), undefined)
  assert.ok(await sessions.user(otherSid, other))
  await assert.rejects(challenges.consume({ challenge: staleChallenge.challenge, recovery: true, code: codes.codes[1] }, async () => {}), { status: 401 })
  await assert.rejects(management.disable({ ...input, code: codes.codes[1] }), { status: 401 })
  const broken = createMfaManagement({ secretBox: noKey, transaction: fn => transaction(tx => fn(async (sql, args) => {
    if (sql.startsWith('UPDATE user_sessions SET auth_version=')) throw Error('synthetic management rollback')
    return tx(sql, args)
  })) })
  const beforeFailure = await state(), savedVersion = await version()
  await assert.rejects(broken.disable({ ...input, code: fresh.recoveryCodes[0] }), /synthetic management rollback/)
  assert.deepEqual(await state(), beforeFailure); assert.equal(await version(), savedVersion)
  assert.ok(await sessions.user(sid, id))
  const raced = await Promise.allSettled([management.regenerate({ ...input, code: fresh.recoveryCodes[0] }), recoveryOnly.regenerate({ ...input, code: fresh.recoveryCodes[0] })])
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(raced.filter(r => r.status === 'rejected' && r.reason.status === 401).length, 1)
  const replacement = raced.find(r => r.status === 'fulfilled').value.recoveryCodes
  assert.equal(await version(), savedVersion + 1)
  const lateChallenge = await challenges.issue(id, hash)
  // A demoted Admin still controls their own existing factor; nobody else's.
  await q("UPDATE users SET role='dev' WHERE id=$1", [id])
  await recoveryOnly.disable({ ...input, code: replacement[0] })
  const disabled = await state()
  assert.equal(disabled.enabled, false); assert.equal(disabled.secret_box, null); assert.deepEqual(disabled.recovery_hashes, [])
  assert.equal(disabled.last_step, '-1'); assert.equal(disabled.challenge_hash, null); assert.equal(disabled.pending_box, null)
  assert.equal(disabled.failures, 0); assert.equal(await version(), savedVersion + 2)
  assert.ok(await sessions.user(sid, id)); assert.equal((await q('SELECT mfa_verified FROM user_sessions WHERE id=$1', [sid])).rows[0].mfa_verified, false)
  assert.equal(await sessions.create(crypto.randomUUID(), id, hash, expires), true)
  await assert.rejects(challenges.consume({ challenge: lateChallenge.challenge, code: replacement[1], recovery: true }, async () => {}), { status: 401 })
  assert.ok(await sessions.user(otherSid, other))
})
