import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../app.js'
import { readyRow } from '../../test-support/readiness.js'

test('disabled recovery exposes only availability and rejects mutation, origin and oversized bodies before SQL', async t => {
  const audit = [], unexpected = () => { throw Error('Unexpected SQL') }
  const app = createApp({ q: unexpected, transaction: unexpected, secret: 'synthetic-recovery-http-secret', origin: 'https://example.invalid', recoveryConfig: { enabled: false }, auditWriter: event => audit.push(event) })
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api`
  const request = (path, body, origin = 'https://example.invalid') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify(body) })
  let response = await fetch(base + '/recovery'); assert.deepEqual(await response.json(), { enabled: false })
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  response = await request('/recovery/request', { email: 'synthetic@example.invalid' }); assert.equal(response.status, 403)
  response = await request('/recovery/reset', { token: 'a'.repeat(64), newPassword: 'isolated-password' }); assert.equal(response.status, 403)
  response = await request('/recovery/confirm-email', { token: 'a'.repeat(64), currentPassword: 'isolated-password' }); assert.equal(response.status, 403)
  response = await request('/me/email', { email: 'synthetic@example.invalid', currentPassword: 'isolated-password' }); assert.equal(response.status, 401)
  response = await request('/recovery/reset', {}, 'https://other.invalid'); assert.equal(response.status, 403)
  response = await request('/recovery/reset', { token: 'a'.repeat(5000) }); assert.equal(response.status, 413)
  const events = JSON.stringify(audit)
  for (const value of ['synthetic@example.invalid', 'isolated-password', 'a'.repeat(64)]) assert.equal(events.includes(value), false)
})

test('recovery readiness requires its capability only when explicitly enabled', async t => {
  for (const enabled of [false, true]) {
    const app = createApp({ q: async query => ({ rows: [readyRow(query.text.includes('recovery_schema_version') ? 0 : 1)] }),
      secret: 'synthetic-recovery-readiness-secret', recoveryConfig: { enabled, origin: 'https://example.invalid' }, registrationConfig: { enabled: false } })
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/ready`)).status, enabled ? 503 : 200)
  }
})
