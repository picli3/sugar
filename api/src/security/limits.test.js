import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { errorHandler, asyncRoute } from '../shared/http.js'
import { clientNetwork, proxyList, loginInput, limitsConfig, createAccessControls } from './limits.js'
import { createAuthService } from '../auth/service.js'
import bcrypt from 'bcryptjs'
const config = { ...limitsConfig({}), ip: 1000, global: 10000, loginIp: 1000, loginGlobal: 10000, account: 100 }
async function server(t, options = {}) {
  let now = 1000000, checks = 0
  const app = express(), controls = createAccessControls({ secret: 'isolated-limiter-key', config: { ...config, ...options.config }, clock: () => now })
  app.set('trust proxy', proxyList(options.proxy || ''))
  app.use(controls.api); app.use(express.json())
  if (options.realAuth) {
    const auth = createAuthService({ secret: 'test', users: { findActiveByEmail: async () => { checks++; return null } }, runCredential: controls.runCredential })
    app.post('/login', controls.login, asyncRoute(async (req, res) => res.json(await auth.login(req.body))))
  } else app.post('/login', controls.login, (_req, res) => { checks++; res.status(401).json({ error: 'Credenciales inválidas' }) })
  app.get('/health', (_req, res) => res.json({ ok: true }))
  app.get('/read', (_req, res) => { checks++; res.json({ ok: true }) })
  app.use(errorHandler)
  const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve))
  t.after(() => new Promise(resolve => listener.close(resolve)))
  return { controls, advance: ms => { now += ms }, checks: () => checks,
    req: async (path = '/login', { email = 'target@local', headers = {} } = {}) => fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method: path === '/login' ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: path === '/login' ? JSON.stringify({ email, password: 'wrong-password' }) : undefined }),
  }
}
test('IP/header spoofing does not bypass socket-based budgets; health checks remain available', async t => {
  const s = await server(t, { config: { ip: 2 } })
  for (let i = 0; i < 2; i++) assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': `198.51.100.${i}`, 'x-real-ip': `203.0.113.${i}` } })).status, 200)
  const blocked = await s.req('/read', { headers: { forwarded: 'for=203.0.113.10', 'x-forwarded-for': '203.0.113.10' } })
  assert.equal(blocked.status, 429); assert.equal(s.checks(), 2); assert.equal(blocked.headers.get('retry-after'), '60'); assert.equal(blocked.headers.get('cache-control'), 'private, no-store')
  assert.equal((await s.req('/health')).status, 200)
  s.advance(60001); assert.equal((await s.req('/read')).status, 200)
})
test('explicit proxy lists stop at the nearest untrusted address, ignoring forged left entries', async t => {
  const s = await server(t, { proxy: '127.0.0.1/32', config: { ip: 1 } })
  assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.9' } })).status, 200)
  assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': '5.6.7.8, 198.51.100.9' } })).status, 429)
  assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': '198.51.100.10' } })).status, 200)
})
test('account cooldown grows without sleeping connections or extending rejected attempts indefinitely', async t => {
  const s = await server(t)
  for (let i = 0; i < 3; i++) assert.equal((await s.req()).status, 401)
  let res = await s.req(); assert.equal(res.status, 429); assert.equal(res.headers.get('retry-after'), '1'); assert.equal(s.checks(), 3)
  s.advance(1001); assert.equal((await s.req()).status, 401)
  res = await s.req(); assert.equal(res.headers.get('retry-after'), '2')
  assert.equal((await s.req('/login', { email: 'other@local' })).status, 401)
  s.advance(15 * 60000); assert.equal((await s.req()).status, 401)
})
test('per-account and per-IP login budgets reject before authentication, independent of account spelling', async t => {
  const s = await server(t, { config: { account: 2, loginIp: 3 } })
  assert.equal((await s.req()).status, 401); assert.equal((await s.req('/login', { email: ' TARGET@LOCAL ' })).status, 401)
  assert.equal((await s.req()).status, 429); assert.equal(s.checks(), 2)
  assert.equal((await s.req('/login', { email: 'other@local' })).status, 429)
})
test('bcrypt work is bounded and the slot remains occupied until the operation ends', async () => {
  const controls = createAccessControls({ secret: 'test', config: { ...config, parallel: 1 } })
  let finish, started = 0
  const task = controls.runCredential(() => { started++; return new Promise(resolve => { finish = resolve }) })
  await assert.rejects(controls.runCredential(() => { started++ }), { status: 429, retryAfter: 1 })
  assert.equal(started, 1); finish(); await task
  await controls.runCredential(async () => { started++ }); assert.equal(started, 2)
  await assert.rejects(controls.runCredential(async () => { throw Error('failure') }), /failure/)
  await controls.runCredential(async () => {})
})
test('bounded key storage fails closed until expiry and IPv6 rotations share a /64 budget', async t => {
  const s = await server(t, { proxy: '127.0.0.1/32', config: { keys: 2 } })
  assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200)
  assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': '198.51.100.2' } })).status, 429)
  s.advance(60001); assert.equal((await s.req('/read', { headers: { 'x-forwarded-for': '198.51.100.2' } })).status, 200)
  for (const address of ['::ffff:192.0.2.1', '::ffff:c000:201', '192.0.2.1']) assert.equal(clientNetwork(address), '192.0.2.1')
  assert.equal(clientNetwork('2001:db8:1:2::1'), clientNetwork('2001:0db8:0001:0002:abcd::42'))
  assert.notEqual(clientNetwork('2001:db8:1:3::1'), clientNetwork('2001:db8:1:2::1'))
})
test('invalid authentication input and unsafe configuration fail before bcrypt/database', async () => {
  for (const body of [null, [], {}, { email: {}, password: 'abc' }, { email: 'a@b', password: {} }, { email: 'not-email', password: 'abc' }, { email: 'a@b', password: 'x'.repeat(1025) }]) assert.throws(() => loginInput(body), { status: 400 })
  for (const value of ['true', '1', 'uniquelocal', '0.0.0.0/0', '::/0', '127.0.0.1/33', true]) assert.throws(() => proxyList(value))
  assert.deepEqual(proxyList('127.0.0.1/32,::1/128'), ['127.0.0.1/32','::1/128'])
  for (const env of [{ AUTH_IP_LIMIT: '0' }, { AUTH_HASH_CONCURRENCY: '1000' }]) assert.throws(() => limitsConfig(env))
})
test('unknown and known invalid accounts use one bcrypt comparison and identical public errors', async () => {
  const hashes = [], knownHash = await bcrypt.hash('irrelevant-password', 12)
  const service = createAuthService({ users: { findActiveByEmail: async email => email === 'known@local' ? { password_hash: knownHash } : null }, secret: 'test', comparePassword: async (_password, hash) => { hashes.push(hash); return false } })
  for (const email of ['known@local', 'missing@local']) await assert.rejects(service.login({ email, password: 'wrong' }), { status: 401, message: 'Credenciales inválidas' })
  assert.deepEqual(hashes.map(hash => bcrypt.getRounds(hash)), [12, 12])
})

test('a real bcrypt burst is rejected before additional account queries or password comparisons', async t => {
  const s = await server(t, { realAuth: true, config: { loginIp: 2, parallel: 1 } })
  const replies = await Promise.all(Array.from({ length: 30 }, (_, i) => s.req('/login', { headers: { 'x-forwarded-for': '198.51.100.' + i } })))
  assert.equal(replies.filter(r => r.status === 401).length, 1)
  assert.equal(replies.filter(r => r.status === 429).length, 29)
  assert.equal(s.checks(), 1)
})

test('MFA verification has independent IP/global and per-challenge budgets with bounded expiry', () => {
  let now = 0
  const controls = createAccessControls({ secret: 'synthetic-mfa-gate-key', config: { ...config, loginIp: 1000, loginGlobal: 1000 }, clock: () => now })
  const gate = (ip, challenge) => new Promise(resolve => controls.mfa({ ip, body: { challenge } }, {}, resolve))
  return (async () => {
    for (let i = 0; i < 10; i++) assert.equal(await gate('192.0.2.' + i, 'a'.repeat(43)), undefined)
    assert.equal((await gate('192.0.2.20', 'a'.repeat(43))).status, 429)
    now += 60_001
    assert.equal((await gate('192.0.2.21', 'a'.repeat(43))).status, 429)
    assert.equal(await gate('192.0.2.22', 'b'.repeat(43)), undefined)
    now += 15 * 60_000
    assert.equal(await gate('192.0.2.23', 'a'.repeat(43)), undefined)
  })()
})
