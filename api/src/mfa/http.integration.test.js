import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { createApp } from '../app.js'
import { createTransaction } from '../db.js'
import { initSessionDb } from '../auth/sessions.js'
import { limitsConfig } from '../security/limits.js'
import { decodeSecret, hotp } from './totp.js'

const url = process.env.API_TEST_DATABASE_URL
test('MFA HTTP enrolls only confirmed Admins, withholds sessions until verification and recovers without its encryption key', { skip: !url }, async t => {
  const schema = 'mfa_http_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text UNIQUE,role text,language text DEFAULT 'es',theme text DEFAULT 'light',active boolean DEFAULT true,password_hash text)`)
  await initSessionDb(q)
  const id = crypto.randomUUID(), dev = crypto.randomUUID(), password = 'isolated-mfa-password', hash = await bcrypt.hash(password, 4), audit = []
  await q("INSERT INTO users(id,email,role,password_hash) VALUES($1,'admin@example.invalid','Admin',$3),($2,'dev@example.invalid','dev',$3)", [id, dev, hash])
  const transaction = createTransaction(db), config = { ...limitsConfig({}), ip: 10000, global: 10000, loginIp: 1000, loginGlobal: 1000, account: 1000, credentials: 1000 }
  const bases = []
  for (const enabled of [true, false]) {
    const app = createApp({ q, transaction, secret: 'synthetic-mfa-http-signing-key-only', mfaKey: enabled ? 'c'.repeat(64) : undefined, mfaEnrollmentEnabled: enabled,
      accessConfig: config, sessionSecure: true, registrationConfig: { enabled: false }, recoveryConfig: { enabled: false }, auditWriter: e => audit.push(e) })
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    bases.push(`http://127.0.0.1:${server.address().port}/api`)
  }
  async function req(path, body, cookie, index = 0) {
    const res = await fetch(bases[index] + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0], header: res.headers.get('set-cookie') }
  }
  const login = (email = 'admin@example.invalid', index = 0) => req('/login', { email, password }, null, index)
  const first = await login(), copy = await login(), devLogin = await login('dev@example.invalid')
  assert.equal(first.status, 200); assert.match(first.header, /HttpOnly/); assert.match(first.header, /Secure/); assert.match(first.header, /SameSite=Strict/)
  assert.deepEqual((await req('/me/mfa', null, first.cookie)).body, { enabled: false, recoveryCodesRemaining: 0, keyAvailable: true, canEnroll: true })
  assert.equal((await req('/me/mfa/enroll', { currentPassword: password })).status, 401)
  assert.equal((await req('/me/mfa/enroll', { currentPassword: password }, first.cookie, 1)).status, 403)
  assert.equal((await req('/me/mfa/enroll', { currentPassword: password }, devLogin.cookie)).status, 403)
  for (const body of [{ currentPassword: 'wrong' }, { currentPassword: password, userId: dev }, { currentPassword: password, mfa_verified: true }]) assert.equal((await req('/me/mfa/enroll', body, first.cookie)).status, 400)
  const setup = await req('/me/mfa/enroll', { currentPassword: password }, first.cookie)
  assert.equal(setup.status, 200); assert.match(setup.body.secret, /^[A-Z2-7]{32}$/)
  assert.equal(JSON.stringify((await q('SELECT * FROM mfa_credentials')).rows).includes(setup.body.secret), false)
  const proof = { enrollmentId: setup.body.enrollmentId, code: 'bad' }
  assert.equal((await req('/me/mfa/confirm', proof, first.cookie)).status, 400)
  assert.equal((await req('/me', null, first.cookie)).status, 200)
  assert.equal((await req('/me/mfa/confirm', proof, first.cookie, 1)).status, 403)
  const now = (await q('SELECT clock_timestamp() AS now')).rows[0].now.getTime()
  proof.code = hotp(decodeSecret(setup.body.secret), Math.floor(now / 30_000))
  const confirmed = await req('/me/mfa/confirm', proof, first.cookie)
  assert.equal(confirmed.status, 200); assert.equal(confirmed.body.recoveryCodes.length, 10)
  const codes = confirmed.body.recoveryCodes, currentCookie = confirmed.cookie
  assert.notEqual(currentCookie, first.cookie)
  assert.equal((await req('/me', null, first.cookie)).status, 401)
  assert.equal((await req('/me', null, copy.cookie)).status, 401)
  assert.equal((await req('/me', null, currentCookie)).status, 200)
  const state = (await req('/me/mfa', null, currentCookie)).body
  assert.deepEqual(state, { enabled: true, recoveryCodesRemaining: 10, keyAvailable: true, canEnroll: false })
  const pending = await login()
  assert.equal(pending.status, 202); assert.equal(pending.cookie, 'session=')
  assert.deepEqual(Object.keys(pending.body).sort(), ['challenge','expiresAt','mfaRequired'].sort())
  assert.equal(pending.body.mfaRequired, true)
  const failed = await req('/login/mfa', { challenge: pending.body.challenge, code: proof.code })
  assert.equal(failed.status, 401); assert.equal(failed.cookie, undefined)
  assert.equal((await req('/login/mfa', { challenge: pending.body.challenge, code: codes[0], recovery: true, mfaVerified: true })).status, 400)
  const signed = await req('/login/mfa', { challenge: pending.body.challenge, code: codes[0], recovery: true })
  assert.equal(signed.status, 200); assert.equal(signed.body.id, id); assert.match(signed.header, /HttpOnly/)
  assert.equal((await req('/login/mfa', { challenge: pending.body.challenge, code: codes[0], recovery: true })).status, 401)
  assert.equal((await req('/me', null, signed.cookie)).status, 200)
  // Missing key and enrollment disabled must not bypass MFA or lock recovery out.
  const noKeyLogin = await login('admin@example.invalid', 1)
  assert.equal(noKeyLogin.status, 202)
  assert.equal((await req('/login/mfa', { challenge: noKeyLogin.body.challenge, code: '000000' }, null, 1)).status, 503)
  const recovered = await req('/login/mfa', { challenge: noKeyLogin.body.challenge, code: codes[1], recovery: true }, null, 1)
  assert.equal(recovered.status, 200); assert.equal((await req('/me', null, recovered.cookie, 1)).status, 200)
  const fresh = await req('/me/mfa/recovery-codes', { currentPassword: password, code: codes[2], recovery: true }, recovered.cookie, 1)
  assert.equal(fresh.status, 200); assert.equal(fresh.body.recoveryCodes.length, 10)
  assert.equal((await req('/me', null, signed.cookie)).status, 401)
  assert.equal((await req('/me', null, recovered.cookie, 1)).status, 401)
  assert.equal((await req('/me', null, fresh.cookie, 1)).status, 200)
  assert.equal((await req('/me/mfa/disable', { currentPassword: password, code: codes[3], recovery: true }, fresh.cookie, 1)).status, 400)
  const disabledReply = await req('/me/mfa/disable', { currentPassword: password, code: fresh.body.recoveryCodes[0], recovery: true }, fresh.cookie, 1)
  assert.equal(disabledReply.status, 200)
  assert.equal((await req('/me', null, fresh.cookie, 1)).status, 401)
  assert.deepEqual((await req('/me/mfa', null, disabledReply.cookie, 1)).body, { enabled: false, recoveryCodesRemaining: 0, keyAvailable: false, canEnroll: false })
  assert.equal((await login('admin@example.invalid', 1)).status, 200)
  // A single remaining backup must recover the account atomically, without
  // demanding an unavailable second code after signing in.
  const lastCode = confirmed.body.recoveryCodes[9], { recoveryHash } = await import('./recovery.js')
  await q('UPDATE mfa_credentials SET enabled=true,secret_box=$2,recovery_hashes=$3 WHERE user_id=$1', [id, { v: 1, iv: '0'.repeat(24), tag: '0'.repeat(32), data: '0'.repeat(64) }, [recoveryHash(id, lastCode)]])
  const lost = await login('admin@example.invalid', 1)
  assert.equal(lost.status, 202)
  assert.equal((await req('/login/mfa/recover', { challenge: lost.body.challenge, code: lastCode, userId: dev }, null, 1)).status, 400)
  const reset = await req('/login/mfa/recover', { challenge: lost.body.challenge, code: lastCode }, null, 1)
  assert.equal(reset.status, 200); assert.equal(reset.body.id, id)
  assert.equal((await req('/me', null, recovered.cookie, 1)).status, 401)
  assert.equal((await req('/me', null, reset.cookie, 1)).status, 200)
  assert.equal((await req('/me/mfa', null, reset.cookie, 1)).body.enabled, false)
  assert.equal((await req('/login/mfa/recover', { challenge: lost.body.challenge, code: lastCode }, null, 1)).status, 401)
  assert.equal((await req('/me/mfa/enroll', { currentPassword: 'x'.repeat(5000) }, reset.cookie)).status, 413)
  assert.ok(audit.some(e => e.operation === 'auth.mfa_confirm' && e.actor === id && e.status === 200))
  assert.ok(audit.some(e => e.operation === 'auth.mfa_verify' && e.actor === id && e.status === 200))
  assert.ok(audit.some(e => e.operation === 'auth.mfa_recover' && e.actor === id && e.status === 200))
  assert.ok(audit.some(e => e.operation === 'auth.mfa_disable' && e.actor === id && e.status === 200))
  const logged = JSON.stringify(audit)
  for (const value of [password, setup.body.secret, setup.body.uri, pending.body.challenge, ...codes, ...fresh.body.recoveryCodes, signed.cookie, 'admin@example.invalid']) assert.equal(logged.includes(value), false)
})
