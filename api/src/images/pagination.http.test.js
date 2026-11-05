import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'

test('gallery pages require a live session and reject invalid pagination before metadata SQL', async t => {
  const id = '11111111-1111-1111-1111-111111111111', sid = '22222222-2222-2222-2222-222222222222', secret = 'synthetic-gallery-page-secret'
  let lookups = 0
  const q = async sql => {
    assert.ok(sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme,u.display_name FROM user_sessions'))
    lookups++; return { rows: [{ id, role: 'view', email: 'fixture@example.invalid', language: 'es', theme: 'light' }] }
  }
  const app = createApp({ q, secret, registrationConfig: { enabled: false }, recoveryConfig: { enabled: false } })
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  let response = await fetch(base + '/images/page')
  assert.equal(response.status, 401); assert.equal(lookups, 0)
  const cookie = 'session=' + jwt.sign({ id, sid }, secret, { expiresIn: 60 })
  for (const path of ['/images/page','/projects/page','/blocks/page']) for (const query of ['limit=101','limit[]=2','cursor=invalid','scope=all']) {
    response = await fetch(base + path + '?' + query, { headers: { cookie } })
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('etag'), null)
  }
  assert.equal(lookups, 12)
})
