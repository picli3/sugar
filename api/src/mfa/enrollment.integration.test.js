import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { initSessionDb, createSessionRepository } from '../auth/sessions.js'
import { createMfaEnrollment } from './enrollment.js'
import { createMfaChallenges } from './challenges.js'
import { createSecretBox } from './secrets.js'
import { decodeSecret, hotp } from './totp.js'

const url = process.env.API_TEST_DATABASE_URL
test('confirmed MFA enrollment preserves only its current session and closes password-only session races', { skip: !url }, async t => {
  const schema = 'mfa_enroll_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,email text,role text,language text DEFAULT 'es',theme text DEFAULT 'light',active boolean DEFAULT true,password_hash text)`)
  await initSessionDb(q); await initSessionDb(q)
  const transaction = createTransaction(db), sessions = createSessionRepository(q, transaction), box = createSecretBox('07'.repeat(32)), enrollment = createMfaEnrollment({ transaction, secretBox: box })
  const hash = 'synthetic-prechecked-password-hash', expires = new Date(Date.now() + 60 * 60 * 1000)
  async function account(role, email) {
    const id = crypto.randomUUID(), sid = crypto.randomUUID()
    await q('INSERT INTO users(id,email,role,password_hash) VALUES($1,$2,$3,$4)', [id, email, role, hash])
    assert.equal(await sessions.create(sid, id, hash, expires), true)
    return { userId: id, sessionId: sid, expectedHash: hash }
  }
  const a = await account('Admin', 'admin@example.invalid'), b = await account('Admin', 'legacy:admin@example.invalid'), dev = await account('dev', 'dev@example.invalid')
  const copy = crypto.randomUUID(); assert.equal(await sessions.create(copy, a.userId, hash, expires), true)
  const state = async () => (await q('SELECT * FROM mfa_credentials WHERE user_id=$1', [a.userId])).rows[0]
  const code = async pending => hotp(decodeSecret(pending.secret), Math.floor((await q('SELECT clock_timestamp() AS now')).rows[0].now.getTime() / 30_000))
  const confirm = (pending, otp, repository = enrollment) => repository.confirm({ ...a, enrollmentId: pending.enrollmentId, code: otp })
  await assert.rejects(enrollment.begin({ ...a, expectedHash: 'stale-hash' }), { status: 401 })
  await assert.rejects(enrollment.begin({ ...a, sessionId: b.sessionId }), { status: 401 })
  await assert.rejects(enrollment.begin(dev), { status: 403 })
  const unavailable = createMfaEnrollment({ transaction, secretBox: createSecretBox(undefined) })
  await assert.rejects(unavailable.begin(a), { status: 503 })
  assert.equal(await state(), undefined)
  let pending = await enrollment.begin(a)
  assert.match(pending.secret, /^[A-Z2-7]{32}$/); assert.match(pending.uri, /^otpauth:\/\/totp\//)
  assert.equal(JSON.stringify(await state()).includes(pending.secret), false)
  assert.equal((await state()).enabled, false)
  assert.ok(await sessions.user(copy, a.userId))
  const prior = pending; pending = await enrollment.begin(a)
  await assert.rejects(confirm(prior, await code(prior)), { status: 401 })
  for (let i = 1; i <= 5; i++) {
    await assert.rejects(confirm(pending, 'invalid'), { status: i === 5 ? 429 : 401 })
    assert.equal((await state()).failures, i)
    if (i < 5) pending = await enrollment.begin(a)
  }
  await assert.rejects(enrollment.begin(a), { status: 429 })
  await q("UPDATE mfa_credentials SET failures_since=now()-interval '16 minutes' WHERE user_id=$1", [a.userId])
  pending = await enrollment.begin(a)
  await q("UPDATE mfa_credentials SET pending_expires_at=now()-interval '1 second' WHERE user_id=$1", [a.userId])
  await assert.rejects(confirm(pending, await code(pending)), { status: 401 })
  pending = await enrollment.begin(a)
  await q('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [a.userId])
  await q('UPDATE user_sessions SET auth_version=auth_version+1 WHERE user_id=$1', [a.userId])
  await assert.rejects(confirm(pending, await code(pending)), { status: 401 })
  pending = await enrollment.begin(a)
  await sessions.revoke(a.sessionId, a.userId)
  await assert.rejects(confirm(pending, await code(pending)), { status: 401 })
  assert.ok((await q('SELECT revoked_at FROM user_sessions WHERE id=$1', [a.sessionId])).rows[0].revoked_at)
  a.sessionId = crypto.randomUUID(); assert.equal(await sessions.create(a.sessionId, a.userId, hash, expires), true)
  pending = await enrollment.begin(a)
  const before = await state(), userBefore = (await q('SELECT auth_version FROM users WHERE id=$1', [a.userId])).rows[0]
  const broken = createMfaEnrollment({ secretBox: box, transaction: task => transaction(tx => task(async (sql, args) => {
    if (sql.startsWith('UPDATE users SET auth_version=')) throw Error('synthetic activation failure')
    return tx(sql, args)
  })) })
  await assert.rejects(confirm(pending, await code(pending), broken), /synthetic activation failure/)
  assert.deepEqual(await state(), before)
  assert.deepEqual((await q('SELECT auth_version FROM users WHERE id=$1', [a.userId])).rows[0], userBefore)
  const results = await Promise.allSettled([confirm(pending, await code(pending)), confirm(pending, await code(pending))])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.status === 401).length, 1)
  const codes = results.find(r => r.status === 'fulfilled').value.recoveryCodes
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10)
  assert.equal((await state()).enabled, true); assert.equal((await state()).pending_box, null)
  for (const value of [pending.secret, ...codes]) assert.equal(JSON.stringify(await state()).includes(value), false)
  assert.equal(await sessions.user(copy, a.userId), undefined)
  assert.ok(await sessions.user(a.sessionId, a.userId)); assert.ok(await sessions.user(b.sessionId, b.userId))
  assert.equal((await sessions.list(a.userId, a.sessionId)).length, 1)
  assert.equal((await q('SELECT mfa_verified FROM user_sessions WHERE id=$1', [a.sessionId])).rows[0].mfa_verified, true)
  await assert.rejects(enrollment.begin(a), { status: 409 })
  assert.equal(await sessions.create(crypto.randomUUID(), a.userId, hash, expires), false)
  await assert.rejects(q('INSERT INTO user_sessions(id,user_id,auth_version,expires_at) VALUES($1,$2,$3,$4)', [crypto.randomUUID(), a.userId, userBefore.auth_version + 1, expires]), { code: 'PZ003' })
  // Even an unverified row made current by a legacy writer cannot authenticate.
  await q('UPDATE user_sessions SET revoked_at=NULL,auth_version=$2 WHERE id=$1', [copy, userBefore.auth_version + 1])
  assert.equal(await sessions.user(copy, a.userId), undefined)
  const challenges = createMfaChallenges({ transaction, secretBox: createSecretBox(undefined) }), challenge = await challenges.issue(a.userId, hash)
  const verifiedId = crypto.randomUUID()
  await challenges.consume({ challenge: challenge.challenge, code: codes[0], recovery: true }, async (tx, user) => {
    assert.equal(await sessions.createVerified(tx, verifiedId, user.id, user.auth_version, expires), true)
  })
  assert.ok(await sessions.user(verifiedId, a.userId))
  const staleVerified = crypto.randomUUID()
  assert.equal(await transaction(tx => sessions.createVerified(tx, staleVerified, a.userId, -1, expires)), false)
  // Concurrent old-style SQL and current repository login must never leave a
  // live password-only session after another account confirms MFA enrollment.
  const pendingB = await enrollment.begin(b)
  assert.equal(new URL(pendingB.uri).pathname.includes(b.userId), true)
  const raced = crypto.randomUUID(), oldReplica = crypto.randomUUID()
  const race = await Promise.allSettled([
    sessions.create(raced, b.userId, hash, expires),
    q('INSERT INTO user_sessions(id,user_id,auth_version,expires_at) VALUES($1,$2,0,$3)', [oldReplica, b.userId, expires]),
    enrollment.confirm({ ...b, enrollmentId: pendingB.enrollmentId, code: await code(pendingB) }),
  ])
  assert.equal(race[2].status, 'fulfilled')
  if (race[1].status === 'rejected') assert.equal(race[1].reason.code, 'PZ003')
  assert.equal(await sessions.user(raced, b.userId), undefined)
  assert.equal(await sessions.user(oldReplica, b.userId), undefined)
  await initSessionDb(q)
  assert.ok(await sessions.user(a.sessionId, a.userId)); assert.ok(await sessions.user(verifiedId, a.userId))
})
