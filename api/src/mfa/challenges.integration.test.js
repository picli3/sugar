import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { initMfaDb } from './migration.js'
import { createMfaChallenges } from './challenges.js'
import { createSecretBox } from './secrets.js'
import { generateSecret, decodeSecret, hotp } from './totp.js'
import { generateRecoveryCodes } from './recovery.js'

const url = process.env.API_TEST_DATABASE_URL
test('MFA login challenges persist throttling and consume replay/recovery proofs atomically across replicas', { skip: !url }, async t => {
  const schema = 'mfa_challenge_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,email text,role text DEFAULT 'Admin',language text DEFAULT 'es',theme text DEFAULT 'light',
    active boolean DEFAULT true,password_hash text,auth_version int DEFAULT 0)`)
  await q('CREATE TABLE completed_logins(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id))')
  await initMfaDb(q)
  const id = crypto.randomUUID(), other = crypto.randomUUID(), passwordHash = 'synthetic-preverified-hash', secret = generateSecret(), box = createSecretBox('06'.repeat(32)), recovery = generateRecoveryCodes(id)
  await q('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)', [id, 'mfa@example.invalid', passwordHash, other, 'other@example.invalid'])
  await q('INSERT INTO mfa_credentials(user_id,enabled,secret_box,recovery_hashes) VALUES($1,true,$2,$3)', [id, box.encrypt(id, secret), recovery.hashes])
  const transaction = createTransaction(db), first = createMfaChallenges({ transaction, secretBox: box }), second = createMfaChallenges({ transaction, secretBox: box })
  const finish = async (tx, user) => {
    assert.deepEqual(Object.keys(user).sort(), ['id','email','role','language','theme','auth_version'].sort())
    const session = crypto.randomUUID(); await tx('INSERT INTO completed_logins VALUES($1,$2)', [session, user.id]); return session
  }
  const issue = () => first.issue(id, passwordHash)
  const consume = (value, code, repository = first, extra = {}, callback = finish) => repository.consume({ challenge: value.challenge, code, ...extra }, callback)
  const state = async () => (await q('SELECT * FROM mfa_credentials WHERE user_id=$1', [id])).rows[0]
  const validOtp = async (offset = 0) => {
    const now = (await q('SELECT clock_timestamp() AS now')).rows[0].now
    return hotp(decodeSecret(secret), Math.floor(now.getTime() / 30_000) + offset)
  }
  assert.equal(await first.issue(other, passwordHash), null)
  await assert.rejects(first.issue(id, 'stale-hash'), { status: 401 })
  let challenge = await issue()
  assert.match(challenge.challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(JSON.stringify(await state()).includes(challenge.challenge), false)
  const superseded = challenge; challenge = await issue()
  await assert.rejects(consume(superseded, await validOtp()), { status: 401 })
  assert.equal((await state()).failures, 0)
  for (let i = 1; i <= 5; i++) {
    await assert.rejects(consume(challenge, 'not-a-code', i % 2 ? first : second), { status: i === 5 ? 429 : 401 })
    assert.equal((await state()).failures, i)
    if (i < 5) challenge = await issue() // A new challenge cannot reset per-account failures.
  }
  await assert.rejects(issue(), { status: 429 })
  await assert.rejects(consume(challenge, recovery.codes[0], second, { recovery: true }), { status: 429 })
  assert.equal((await state()).recovery_hashes.length, 10)
  await q("UPDATE mfa_credentials SET failures_since=now()-interval '16 minutes' WHERE user_id=$1", [id])
  challenge = await issue(); assert.equal((await state()).failures, 0)
  await q("UPDATE mfa_credentials SET challenge_expires_at=now()-interval '1 second' WHERE user_id=$1", [id])
  await assert.rejects(consume(challenge, await validOtp()), { status: 401 })
  challenge = await issue()
  await q('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [id])
  await assert.rejects(consume(challenge, await validOtp()), { status: 401 })
  challenge = await issue()
  await q('UPDATE users SET active=false WHERE id=$1', [id])
  await assert.rejects(consume(challenge, await validOtp()), { status: 401 }); await assert.rejects(issue(), { status: 401 })
  await q('UPDATE users SET active=true WHERE id=$1', [id])
  challenge = await issue()
  const saved = await state()
  await assert.rejects(consume(challenge, await validOtp(), first, {}, async tx => { await tx('INSERT INTO completed_logins VALUES($1,$2)', [crypto.randomUUID(), id]); throw Error('synthetic session failure') }), /synthetic session failure/)
  assert.deepEqual(await state(), saved)
  assert.equal((await q('SELECT count(*)::int AS n FROM completed_logins')).rows[0].n, 0)
  const proof = await validOtp(1) // Future skew accepted; its watermark also rejects the current step.
  const results = await Promise.allSettled([consume(challenge, proof), consume(challenge, proof, second)])
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(results.filter(value => value.status === 'rejected' && value.reason.status === 401).length, 1)
  assert.equal((await q('SELECT count(*)::int AS n FROM completed_logins')).rows[0].n, 1)
  assert.equal((await state()).challenge_hash, null)
  challenge = await issue()
  await assert.rejects(consume(challenge, proof), { status: 401 })
  await assert.rejects(consume(challenge, await validOtp()), { status: 401 })
  assert.equal((await state()).failures, 2)
  // A recovery proof must remain single use after issuing a fresh challenge.
  const noKey = createMfaChallenges({ transaction, secretBox: createSecretBox(undefined) })
  await consume(challenge, recovery.codes[0], noKey, { recovery: true })
  assert.equal((await state()).recovery_hashes.length, 9)
  assert.equal((await state()).failures, 0)
  challenge = await issue()
  await assert.rejects(consume(challenge, recovery.codes[0], noKey, { recovery: true }), { status: 401 })
  const beforeMissing = await state()
  await assert.rejects(consume(challenge, await validOtp(), noKey), { status: 503, message: 'mfaKeyMissing' })
  assert.deepEqual(await state(), beforeMissing)
  await assert.rejects(consume(challenge, recovery.codes[1], noKey, { recovery: true }, async () => { throw Error('synthetic rollback') }), /synthetic rollback/)
  assert.deepEqual(await state(), beforeMissing)
  await consume(challenge, recovery.codes[1], noKey, { recovery: true })
  assert.equal((await state()).recovery_hashes.length, 8)
  challenge = await issue()
  const recoveryRace = await Promise.allSettled([consume(challenge, recovery.codes[2], noKey, { recovery: true }), consume(challenge, recovery.codes[2], second, { recovery: true })])
  assert.equal(recoveryRace.filter(value => value.status === 'fulfilled').length, 1)
  assert.equal(recoveryRace.filter(value => value.status === 'rejected' && value.reason.status === 401).length, 1)
  assert.equal((await state()).recovery_hashes.length, 7)
  challenge = await issue()
  await assert.rejects(consume(challenge, recovery.codes[2], noKey, { recovery: true }), { status: 401 })
  // A code generated for another account is never accepted for this account.
  await assert.rejects(consume(challenge, generateRecoveryCodes(other).codes[0], noKey, { recovery: true }), { status: 401 })
  for (const invalid of [null,123,'','x'.repeat(42),'x'.repeat(44),'<script>']) await assert.rejects(first.consume({ challenge: invalid, code: '000000' }, finish), { status: 401 })
  await assert.rejects(first.consume({ challenge: challenge.challenge, code: '000000' }), TypeError)
})
