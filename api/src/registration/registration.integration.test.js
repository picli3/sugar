import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { createApp } from '../app.js'
import { createTransaction } from '../db.js'
import { initSessionDb } from '../auth/sessions.js'
import { initRegistrationDb, createRegistrationRepository } from './repository.js'
import { createRegistrationService } from './service.js'
import { createMailService } from '../mail/service.js'
import { limitsConfig } from '../security/limits.js'

const url = process.env.API_TEST_DATABASE_URL
test('registration with a simulated mailbox persists verification, expiry, single use and existing-account isolation in PostgreSQL', { skip: !url }, async t => {
  const schema = 'registration_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args), transaction = createTransaction(pool)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text UNIQUE NOT NULL,password_hash text NOT NULL,role text NOT NULL CHECK(role IN ('view','dev','Admin')),language text NOT NULL DEFAULT 'es',theme text NOT NULL DEFAULT 'light',active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now())`)
  await initSessionDb(q); await initRegistrationDb(q); await initRegistrationDb(q)
  const emails = [], config = { enabled: true, origin: 'https://example.invalid' }, repository = createRegistrationRepository(q, transaction)
  await q('CREATE TABLE settings(key text PRIMARY KEY,value jsonb NOT NULL)')
  const mailEnv = { MAIL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') }, mailConnections = [], messages = []
  const mail = createMailService({ q, env: mailEnv, transportFactory: options => {
    mailConnections.push(options)
    return { verify: async () => true, sendMail: async message => messages.push(message), close: () => {} }
  } })
  const app = createApp({ q, transaction, secret: 'synthetic-registration-secret', registrationConfig: config, sendVerification: async message => { emails.push(message) }, mailService: mail, accessConfig: { ...limitsConfig({}), credentials: 100 }, auditWriter: () => {} })
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const req = async (path, body, cookie, method = body ? 'POST' : 'GET') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const token = () => new URL(emails.at(-1).url).hash.slice('#verify-email='.length), password = 'isolated-registration-password'
  assert.deepEqual(await req('/registration/request', { email: ' New@Example.invalid ', language: 'en' }), { status: 202, body: { ok: true }, cookie: undefined })
  const first = token(), saved = (await q('SELECT * FROM pending_registrations')).rows[0]
  assert.notEqual(saved.token_hash, first); assert.equal(saved.token_hash, crypto.createHash('sha256').update(first).digest('hex'))
  assert.equal((await q('SELECT count(*)::int AS n FROM users')).rows[0].n, 0)
  assert.equal((await req('/login', { email: 'new@example.invalid', password })).status, 401)
  await req('/registration/request', { email: 'new@example.invalid' }); assert.equal(emails.length, 1)
  assert.equal((await req('/registration/verify', { token: first, password, role: 'Admin' })).status, 400)
  const results = await Promise.all([req('/registration/verify', { token: first, password }), req('/registration/verify', { token: first, password })])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400])
  const user = (await q('SELECT * FROM users')).rows[0]
  assert.equal(user.role, 'dev'); assert.equal(user.language, 'en'); assert.equal(user.theme, 'light'); assert.ok(user.email_verified_at)
  assert.equal(await bcrypt.compare(password, user.password_hash), true)
  assert.equal((await req('/registration/verify', { token: first, password })).status, 400)
  const login = await req('/login', { email: user.email, password }); assert.equal(login.status, 200)
  assert.equal((await req('/users', undefined, login.cookie)).status, 403)
  assert.equal((await req('/ai', undefined, login.cookie)).status, 403)
  assert.equal((await req('/mail', undefined, login.cookie)).status, 403)
  assert.equal((await req('/mail', {}, login.cookie, 'PUT')).status, 403)
  assert.equal((await req('/mail/test', {}, login.cookie)).status, 403)
  // Independent service over the same DB avoids unrelated IP budgets for lifecycle cases.
  const service = createRegistrationService({ repository, config, sendVerification: async message => emails.push(message) })
  await service.request({ email: user.email }); const existing = token()
  await assert.rejects(service.verify({ token: existing, password: 'replacement-password' }), { status: 400 })
  assert.equal((await q('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0].password_hash, user.password_hash)
  await service.request({ email: 'expired@example.invalid' }); const expired = token()
  await q('UPDATE pending_registrations SET expires_at=now()-interval \'1 second\'')
  await assert.rejects(service.verify({ token: expired, password }), { status: 400 })
  await service.request({ email: 'rotate@example.invalid' }); const old = token()
  await q('UPDATE pending_registrations SET created_at=now()-interval \'2 minutes\'')
  await service.request({ email: 'rotate@example.invalid' }); const fresh = token()
  assert.notEqual(old, fresh); await assert.rejects(service.verify({ token: old, password }), { status: 400 })
  await service.verify({ token: fresh, password })
  // A second repository/process observes consumption and persisted verified account state.
  assert.equal(await createRegistrationRepository(q, transaction).valid(crypto.createHash('sha256').update(fresh).digest('hex')), false)
  assert.equal((await q('SELECT count(*)::int AS n FROM users WHERE email_verified_at IS NOT NULL')).rows[0].n, 2)
  const inactiveId = crypto.randomUUID()
  await q('INSERT INTO users(id,email,password_hash,role,active) VALUES($1,$2,$3,$4,false)', [inactiveId, 'inactive@example.invalid', user.password_hash, 'Admin'])
  await service.request({ email: 'inactive@example.invalid' }); const inactive = token()
  await assert.rejects(service.verify({ token: inactive, password }), { status: 400 })
  assert.equal((await q('SELECT active FROM users WHERE id=$1', [inactiveId])).rows[0].active, false)
  // If account insertion fails, token deletion is rolled back on the same connection.
  await service.request({ email: 'rollback@example.invalid' }); const rollback = token(), rollbackHash = crypto.createHash('sha256').update(rollback).digest('hex')
  await assert.rejects(repository.consume(rollbackHash, user.id, 'not-used'), { code: '23505' })
  assert.equal(await repository.valid(rollbackHash), true)

  await t.test('Admin stores encrypted SMTP credentials, blank preserves them, replacement/clear work and connection test sends no mail', async () => {
    const id = crypto.randomUUID()
    await q('INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)', [id, 'admin@example.invalid', user.password_hash, 'Admin'])
    const adminLogin = await req('/login', { email: 'admin@example.invalid', password })
    assert.equal(adminLogin.status, 200)
    const settings = { host: 'smtp.example.invalid', port: 587, username: 'synthetic-smtp-user', from: 'sugar@example.invalid', password: 'invented-smtp-password' }
    let response = await req('/mail', settings, adminLogin.cookie, 'PUT')
    assert.equal(response.status, 200); assert.equal(response.body.password_configured, true)
    const stored = async () => (await q("SELECT value FROM settings WHERE key='mail_config'")).rows[0].value
    const original = await stored()
    assert.ok(original.password_enc); assert.equal(JSON.stringify(original).includes(settings.password), false)
    assert.equal(JSON.stringify(response.body).includes(settings.password), false); assert.equal(response.body.password_enc, undefined)
    response = await req('/mail', { ...settings, password: '' }, adminLogin.cookie, 'PUT')
    assert.equal(response.status, 200); assert.deepEqual((await stored()).password_enc, original.password_enc)
    await Promise.all([mail.save({ ...settings, password: '' }), mail.save({ ...settings, password: 'replacement-smtp-password' })])
    response = await req('/mail/test', {}, adminLogin.cookie)
    assert.equal(response.status, 200); assert.equal(mailConnections.at(-1).auth.pass, 'replacement-smtp-password'); assert.equal(messages.length, 0)
    await mail.sendVerification({ email: 'test@example.invalid', language: 'es', url: 'https://example.invalid/#verify-email=synthetic' })
    assert.equal(messages.length, 1); assert.match(messages[0].text, /30 minutos/)
    const wrong = createMailService({ q, env: { MAIL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') } })
    await assert.rejects(wrong.assertConfigured(), { code: 'SECRET_CONFIG' })
    response = await req('/mail', { ...settings, password: '', clearPassword: true }, adminLogin.cookie, 'PUT')
    assert.equal(response.status, 200); assert.equal(response.body.password_configured, false)
    assert.equal((await stored()).password_enc, null)
    const connectionsBefore = mailConnections.length
    response = await req('/mail/test', {}, adminLogin.cookie)
    assert.equal(response.status, 502); assert.equal(mailConnections.length, connectionsBefore)
  })
  await t.test('pending storage fails closed at capacity without sending mail or creating accounts', async () => {
    await q('DELETE FROM pending_registrations')
    await q(`INSERT INTO pending_registrations(email,token_hash,language,expires_at)
      SELECT 'capacity-'||i||'@example.invalid',md5(i::text)||md5('fixture-'||i),'es',now()+interval '30 minutes' FROM generate_series(1,10000) AS i`)
    const before = emails.length
    await service.request({ email: 'capacity-overflow@example.invalid' })
    assert.equal(emails.length, before)
    assert.equal((await q('SELECT count(*)::int AS n FROM pending_registrations')).rows[0].n, 10000)
  })
})
