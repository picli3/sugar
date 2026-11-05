import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import { createApp } from './app.js'

const user = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@local', role: 'Admin', language: 'es', theme: 'light' }
const project = { id: 'p', created_by: user.id, visibility: 'public', name: 'Public', yaml: 'name: Public\nnodes: []\nedges: []\n', revision: 1, creator: user.email, share_token: 'not-public', sync_repository: 'private/repo' }

test('constructing the application does not listen, initialize DB or start timers/workers', () => {
  const script = `
    import net from 'node:net';
    net.Server.prototype.listen = () => { throw Error('Unexpected listen') };
    globalThis.setInterval = () => { throw Error('Unexpected interval') };
    const { createApp } = await import('./src/app.js');
    const unexpected = () => { throw Error('Unexpected dependency call') };
    const app = createApp({ q: unexpected, transaction: unexpected, secret: 'test', enqueue: unexpected, syncOne: unexpected });
    if (typeof app !== 'function') throw Error('Expected Express app');
    console.log('created');
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5000 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout.trim(), 'created')
})

test('HTTP contracts retain public routes, session cookies, authentication and error mapping', async t => {
  const calls = [], hash = bcrypt.hashSync('local-test-password', 4)
  const q = async (sql, params) => {
    calls.push(sql)
    if (sql.startsWith('SELECT * FROM users')) return { rows: params[0] === user.email ? [{ ...user, password_hash: hash }] : [] }
    if (sql.startsWith('SELECT enabled FROM mfa_credentials')) return { rows: [] }
    if (sql.startsWith('SELECT id,active,password_hash,auth_version')) return { rows: [{ id: user.id, active: true, password_hash: hash, auth_version: 0 }] }
    if (sql.startsWith('SELECT * FROM mfa_credentials')) return { rows: [] }
    if (sql.startsWith('SELECT auth_version')) return { rows: [{ auth_version: 0 }] }
    if (sql.startsWith('INSERT INTO user_sessions')) return { rows: [] }
    if (sql.startsWith('UPDATE user_sessions')) return { rowCount: 1, rows: [] }
    if (sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme FROM user_sessions')) return { rows: [user] }
    if (sql.startsWith('SELECT id,email,role,language,theme')) return { rows: params[0] === user.id ? [user] : [] }
    if (sql.includes("p.visibility='public'")) return { rows: params[0] === 'p' ? [project] : [] }
    if (sql.startsWith('SELECT mime,data')) return { rows: [{ mime: 'image/png', data: Buffer.from('test-image') }] }
    if (sql.includes('SELECT id,email,role,active')) throw Object.assign(Error('duplicate'), { code: '23505' })
    if (sql.includes('WHERE p.id=$1')) throw Object.assign(Error('bad id'), { code: '22P02' })
    throw Error('Unexpected query: ' + sql)
  }
  const audit = []
  const app = createApp({ q, transaction: async fn => fn(q), secret: 'test-secret', enqueue: async () => {}, syncOne: async () => {}, sessionSecure: true, auditWriter: event => audit.push(event) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const request = (path, body, cookie) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  let res = await request('/health')
  assert.deepEqual(await res.json(), { ok: true }); assert.equal(calls.length, 0)
  res = await request('/me'); assert.equal(res.status, 401); assert.deepEqual(await res.json(), { error: 'Sesión requerida' })
  res = await request('/me', null, 'session=invalid'); assert.equal(res.status, 401)
  res = await request('/public/projects/p'); assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: 'p', name: project.name, yaml: project.yaml, revision: 1, creator: user.email, visibility: 'public', category_icons: {} })
  res = await request('/public/projects/missing'); assert.equal(res.status, 404); assert.deepEqual(await res.json(), { error: 'Proyecto público no encontrado' })
  res = await request('/shared/invalid'); assert.equal(res.status, 404)
  res = await request('/images/i/content'); assert.equal(res.status, 404); assert.equal(res.headers.get('cache-control'), 'private, no-store')
  res = await request('/images'); assert.equal(res.status, 401)
  res = await request('/login', { email: 'oversized@local', password: 'x'.repeat(5000) }); assert.equal(res.status, 413)
  res = await request('/login', { email: 'missing@local', password: 'wrong' }); assert.equal(res.status, 401); assert.deepEqual(await res.json(), { error: 'Credenciales inválidas' })
  res = await request('/login', { email: 'ADMIN@LOCAL', password: 'local-test-password' }); assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), user)
  assert(audit.some(event => event.operation === 'auth.login' && event.actor === null && event.result === 'denied'))
  assert(audit.some(event => event.operation === 'auth.login' && event.actor === user.id && event.result === 'success'))
  assert(!JSON.stringify(audit).includes('local-test-password'))
  assert(!JSON.stringify(audit).includes(user.email))
  const setCookie = res.headers.get('set-cookie'), cookie = setCookie.split(';')[0]
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Path=\//)
  res = await request('/me', null, cookie); assert.deepEqual(await res.json(), user)
  res = await request('/users', null, cookie); assert.equal(res.status, 409); assert.deepEqual(await res.json(), { error: 'Ya existe un registro con ese nombre o identificador' })
  res = await request('/projects/not-uuid', null, cookie); assert.equal(res.status, 400); assert.deepEqual(await res.json(), { error: 'Identificador inválido' })
  res = await request('/logout', {}, cookie); assert.deepEqual(await res.json(), { ok: true }); assert.match(res.headers.get('set-cookie'), /session=;/)
})
