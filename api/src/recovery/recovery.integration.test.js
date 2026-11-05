import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { createApp } from '../app.js'
import { createTransaction } from '../db.js'
import { initSessionDb } from '../auth/sessions.js'
import { initRegistrationDb } from '../registration/repository.js'
import { initRecoveryDb, createRecoveryRepository } from './repository.js'
import { createRecoveryService } from './service.js'
import { limitsConfig } from '../security/limits.js'

const url = process.env.API_TEST_DATABASE_URL
test('account recovery and dual email confirmation preserve isolation and atomically revoke sessions in disposable PostgreSQL', { skip: !url }, async t => {
  const schema = 'recovery_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args), transaction = createTransaction(pool)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text UNIQUE NOT NULL,password_hash text NOT NULL,role text NOT NULL CHECK(role IN ('view','dev','Admin')),language text NOT NULL DEFAULT 'es',theme text NOT NULL DEFAULT 'light',active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now())`)
  await initSessionDb(q); await initRegistrationDb(q); await initRecoveryDb(q); await initRecoveryDb(q)
  const password = 'isolated-recovery-password', hash = await bcrypt.hash(password, 12), ids = {}, messages = [], audit = []
  for (const [name, verified, active, role] of [['first', true, true, 'dev'], ['other', true, true, 'dev'], ['legacy', false, true, 'Admin'], ['inactive', true, false, 'dev']]) {
    ids[name] = crypto.randomUUID()
    await q('INSERT INTO users(id,email,password_hash,role,email_verified_at,active) VALUES($1,$2,$3,$4,$5,$6)', [ids[name], name + '@example.invalid', hash, role, verified ? new Date() : null, active])
  }
  let failPurpose = ''
  const mail = { sendAccountMessage: async message => { if (message.purpose === failPurpose) throw Error('private-mail-diagnostic'); messages.push(message) } }
  const config = { enabled: true, origin: 'https://example.invalid' }, repository = createRecoveryRepository(q, transaction)
  const service = createRecoveryService({ repository, config, mail })
  const app = createApp({ q, transaction, secret: 'synthetic-recovery-secret', mailService: mail, recoveryConfig: config, registrationConfig: { enabled: false }, auditWriter: e => audit.push(e), accessConfig: { ...limitsConfig({}), loginIp: 1000, loginGlobal: 1000, account: 1000, credentials: 1000 } })
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const req = async (path, body, cookie) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (email, pass = password) => { const r = await req('/login', { email, password: pass }); assert.equal(r.status, 200); return r.cookie }
  const token = message => new URL(message.url).hash.split('=')[1], digest = value => crypto.createHash('sha256').update(value).digest('hex')
  const last = purpose => messages.filter(m => m.purpose === purpose).at(-1)
  let currentPassword = password, currentEmail = 'first@example.invalid'
  const one = await login(currentEmail), two = await login(currentEmail), other = await login('other@example.invalid')
  assert.equal((await req('/me/email', undefined, one)).body.verified, true)
  assert.equal((await req('/me/email')).status, 401)

  await t.test('uniform reset requests and concurrent single use close copied sessions without affecting another account', async () => {
    const replies = []
    for (const email of [currentEmail, 'unknown@example.invalid', 'inactive@example.invalid']) replies.push(await req('/recovery/request', { email }))
    assert.ok(replies.every(r => r.status === 202 && JSON.stringify(r.body) === '{"ok":true}'))
    assert.equal((await req('/recovery/request', { email: 'fourth@example.invalid' })).status, 429)
    assert.equal(messages.length, 3)
    const first = token(messages[0]), unknown = token(messages[1]), inactive = token(messages[2])
    const row = await repository.lookup(digest(first), 'reset'); assert.notEqual(row.token_hash, first)
    assert.equal((await req('/me', undefined, one)).status, 200)
    // An unknown-address token must not attach to an account created later.
    const later = crypto.randomUUID()
    await q('INSERT INTO users(id,email,password_hash,role,email_verified_at) VALUES($1,\'unknown@example.invalid\',$2,\'dev\',now())', [later, hash])
    await assert.rejects(service.reset({ token: unknown, newPassword: 'replacement-password' }), { status: 400 })
    assert.equal((await repository.user(later)).password_hash, hash)
    await assert.rejects(service.reset({ token: inactive, newPassword: 'replacement-password' }), { status: 400 })
    const attempts = await Promise.all([req('/recovery/reset', { token: first, newPassword: 'replacement-password' }), req('/recovery/reset', { token: first, newPassword: 'replacement-password' })])
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 400]); assert.equal(attempts.find(r => r.status === 200).cookie, 'session=')
    assert.equal((await req('/me', undefined, one)).status, 401); assert.equal((await req('/me', undefined, two)).status, 401)
    assert.equal((await req('/me', undefined, other)).status, 200)
    assert.equal((await req('/login', { email: currentEmail, password })).status, 401)
    currentPassword = 'replacement-password'
    assert.equal((await req('/me', undefined, await login(currentEmail, currentPassword))).body.role, 'dev')
    assert.equal(last('password_changed').url, undefined)
    for (const secret of [first, unknown, inactive, password, currentEmail]) assert.equal(JSON.stringify(audit).includes(secret), false)
  })
  await t.test('expiration, rotation, credential-version changes and SQL rollback invalidate or preserve the right token', async () => {
    await service.requestReset({ email: currentEmail }); const stale = token(last('reset'))
    const cookie = await login(currentEmail, currentPassword)
    assert.equal((await req('/me/password', { currentPassword, newPassword: 'second-replacement-password' }, cookie)).status, 200)
    assert.equal(last('password_changed').email, currentEmail)
    currentPassword = 'second-replacement-password'
    await assert.rejects(service.reset({ token: stale, newPassword: 'stale-attempt-password' }), { status: 400 })
    await service.requestReset({ email: currentEmail }); const expired = token(last('reset'))
    await q("UPDATE account_actions SET expires_at=now()-interval '1 second' WHERE email=$1", [currentEmail])
    await assert.rejects(service.reset({ token: expired, newPassword: 'replacement-password' }), { status: 400 })
    await service.requestReset({ email: currentEmail }); const original = token(last('reset'))
    await q("UPDATE account_actions SET created_at=now()-interval '2 minutes' WHERE email=$1", [currentEmail])
    await service.requestReset({ email: currentEmail }); const rotated = token(last('reset')); assert.notEqual(rotated, original)
    await assert.rejects(service.reset({ token: original, newPassword: 'replacement-password' }), { status: 400 })
    const before = (await repository.user(ids.first)).password_hash
    await assert.rejects(repository.reset(digest(rotated), null), { code: '23502' })
    assert.ok(await repository.lookup(digest(rotated), 'reset')); assert.equal((await repository.user(ids.first)).password_hash, before)
    failPurpose = 'password_changed'
    await service.reset({ token: rotated, newPassword: 'third-replacement-password' }); currentPassword = 'third-replacement-password'; failPurpose = ''
    await login(currentEmail, currentPassword)
  })
  await t.test('legacy Admin verifies their own address with reauthentication; an email token cannot reset a password', async () => {
    const cookie = await login('legacy@example.invalid')
    await assert.rejects(service.requestReset({ email: 'legacy@example.invalid', role: 'Admin' }), { status: 400 })
    await service.requestReset({ email: 'legacy@example.invalid' }); const unavailable = token(last('reset'))
    await assert.rejects(service.reset({ token: unavailable, newPassword: 'attacker-password' }), { status: 400 })
    const count = messages.length
    assert.equal((await req('/me/email', { email: 'legacy@example.invalid', currentPassword: 'wrong' }, cookie)).status, 400)
    assert.equal(messages.length, count)
    assert.equal((await req('/me/email', { email: 'legacy@example.invalid', currentPassword: password }, cookie)).status, 202)
    const confirmation = token(last('email_change'))
    await assert.rejects(service.reset({ token: confirmation, newPassword: 'attacker-password' }), { status: 400 })
    assert.equal((await req('/recovery/confirm-email', { token: confirmation, currentPassword: 'wrong' })).status, 400)
    assert.equal((await req('/recovery/confirm-email', { token: confirmation, currentPassword: password })).body.pending, false)
    assert.equal((await req('/me', undefined, cookie)).status, 401)
    const user = await repository.user(ids.legacy); assert.ok(user.email_verified_at); assert.equal(user.password_hash, hash)
    assert.equal((await req('/me', undefined, await login('legacy@example.invalid'))).body.role, 'Admin')
  })
  await t.test('verified email changes need both distinct inbox links and password, preserve role, and revoke all sessions', async () => {
    let cookie = await login(currentEmail, currentPassword)
    assert.equal((await req('/me/email', { email: 'new@example.invalid', currentPassword, userId: ids.other }, cookie)).status, 400)
    await service.requestEmail({ id: ids.first }, { email: 'new@example.invalid', currentPassword })
    const newer = token(last('email_change')), older = token(last('email_change_old'))
    assert.notEqual(older, newer)
    assert.equal((await req('/recovery/confirm-email', { token: newer, currentPassword })).body.pending, true)
    assert.equal((await repository.user(ids.first)).email, currentEmail); assert.equal((await req('/me', undefined, cookie)).status, 200)
    assert.equal((await req('/recovery/confirm-email', { token: newer, currentPassword })).status, 400)
    assert.equal((await req('/recovery/confirm-email', { token: older, currentPassword })).body.pending, false)
    assert.equal((await req('/me', undefined, cookie)).status, 401)
    currentEmail = 'new@example.invalid'; cookie = await login(currentEmail, currentPassword)
    assert.equal((await req('/me', undefined, cookie)).body.role, 'dev')
    // The opposite confirmation order works too.
    await service.requestEmail({ id: ids.first }, { email: 'newer@example.invalid', currentPassword })
    const nextNew = token(last('email_change')), nextOld = token(last('email_change_old'))
    assert.equal((await service.confirmEmail({ token: nextOld, currentPassword })).pending, true)
    assert.equal((await service.confirmEmail({ token: nextNew, currentPassword })).pending, false)
    currentEmail = 'newer@example.invalid'
  })
  await t.test('conflicting addresses, disabled accounts and partial mail delivery never transfer or reactivate an account', async () => {
    const beforeOther = await repository.user(ids.other)
    await service.requestEmail({ id: ids.first }, { email: 'other@example.invalid', currentPassword })
    const newer = token(last('email_change')), older = token(last('email_change_old'))
    await service.confirmEmail({ token: older, currentPassword })
    await assert.rejects(service.confirmEmail({ token: newer, currentPassword }), { status: 400 })
    assert.equal((await repository.user(ids.other)).password_hash, beforeOther.password_hash)
    assert.equal((await repository.user(ids.first)).email, currentEmail)
    failPurpose = 'email_change_old'
    await service.requestEmail({ id: ids.first }, { email: 'undelivered@example.invalid', currentPassword })
    const cancelled = token(last('email_change')); failPurpose = ''
    await assert.rejects(service.confirmEmail({ token: cancelled, currentPassword }), { status: 400 })
    assert.equal((await repository.user(ids.first)).email, currentEmail)
    await service.requestReset({ email: currentEmail }); const stale = token(last('reset'))
    await q('UPDATE users SET active=false,auth_version=auth_version+1 WHERE id=$1', [ids.first])
    await assert.rejects(service.reset({ token: stale, newPassword: 'not-applied-password' }), { status: 400 })
    assert.equal((await q('SELECT active FROM users WHERE id=$1', [ids.first])).rows[0].active, false)
    await q('UPDATE users SET active=true WHERE id=$1', [ids.first])
    await assert.rejects(service.reset({ token: stale, newPassword: 'not-applied-password' }), { status: 400 })
    const ambiguous = crypto.randomUUID()
    await q('INSERT INTO users(id,email,password_hash,role,email_verified_at) VALUES($1,$2,$3,\'Admin\',now())', [ambiguous, currentEmail.toUpperCase(), hash])
    await service.requestReset({ email: currentEmail }); const collision = token(last('reset'))
    await assert.rejects(service.reset({ token: collision, newPassword: 'not-applied-password' }), { status: 400 })
    assert.equal((await repository.user(ambiguous)).password_hash, hash)
  })
  await t.test('pending actions are capacity bounded without leaking recipients through delivery errors', async () => {
    failPurpose = 'reset'; await service.requestReset({ email: 'delivery-error@example.invalid' }); failPurpose = ''
    assert.equal((await q('SELECT 1 FROM account_actions WHERE email=$1', ['delivery-error@example.invalid'])).rowCount, 0)
    await q('DELETE FROM account_actions')
    await q(`INSERT INTO account_actions(kind,email,token_hash,language,expires_at) SELECT 'reset','capacity-'||i||'@example.invalid',md5(i::text)||md5('recovery-fixture-'||i),'es',now()+interval '15 minutes' FROM generate_series(1,10000) AS i`)
    const count = messages.length
    await service.requestReset({ email: 'capacity-overflow@example.invalid' })
    assert.equal(messages.length, count); assert.equal((await q('SELECT count(*)::int AS n FROM account_actions')).rows[0].n, 10000)
  })
  const events = JSON.stringify(audit)
  for (const message of messages) {
    assert.equal(events.includes(message.email), false)
    if (message.url) assert.equal(events.includes(token(message)), false)
  }
  for (const secret of [password, currentPassword, 'second-replacement-password']) assert.equal(events.includes(secret), false)
})
