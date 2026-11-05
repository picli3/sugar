import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../app.js'
import { readyRow } from '../../test-support/readiness.js'
import { createAccessControls, limitsConfig } from '../security/limits.js'

test('public registration endpoints enforce body/origin/rate controls without exposing tokens or recipients', async t => {
  let calls = 0
  const audit = [], unexpected = () => { throw Error('Unexpected SQL') }
  const app = createApp({ q: unexpected, transaction: unexpected, secret: 'synthetic-registration-test-secret', auditWriter: event => audit.push(event), origin: 'https://example.invalid' })
  const listener = app.listen(0, '127.0.0.1')
  await new Promise(resolve => listener.once('listening', resolve)); t.after(() => new Promise(resolve => listener.close(resolve)))
  const base = `http://127.0.0.1:${listener.address().port}/api/registration`
  const request = body => { calls++; return fetch(base + '/request', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://example.invalid' }, body: JSON.stringify(body) }) }
  let response = await fetch(base)
  assert.deepEqual(await response.json(), { enabled: false }); assert.equal(response.headers.get('cache-control'), 'private, no-store')
  response = await fetch(base + '/request', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://evil.invalid' }, body: '{}' })
  assert.equal(response.status, 403)
  response = await request({ email: 'bad' }); assert.equal(response.status, 400)
  response = await request({ email: 'synthetic@example.invalid' }); assert.equal(response.status, 403)
  response = await request({ email: 'other@example.invalid', role: 'Admin' }); assert.equal(response.status, 400)
  response = await request({ email: 'third@example.invalid' }); assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after') !== null, true)
  response = await fetch(base + '/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64), password: 'isolated-password' }) })
  assert.equal(response.status, 403)
  const text = JSON.stringify(audit)
  for (const secret of ['example.invalid', 'isolated-password', 'a'.repeat(64)]) assert.equal(text.includes(secret), false)
  assert.ok(audit.some(event => event.operation === 'auth.registration_verify'))
  response = await fetch(base + '/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(5000) }) })
  assert.equal(response.status, 413)
})

test('registration limits follow email spelling across client addresses and bound verification attempts', () => {
  const controls = createAccessControls({ secret: 'synthetic-registration-limits-secret', config: limitsConfig({}) })
  const request = (ip, verify = false) => {
    let failure
    controls.registration({ ip, path: '/api/registration/' + (verify ? 'verify' : 'request'), body: { email: ' SAME@EXAMPLE.INVALID ' } }, {}, e => { failure = e })
    return failure
  }
  for (let i = 1; i <= 3; i++) assert.equal(request('198.51.100.' + i), undefined)
  assert.equal(request('198.51.100.4').status, 429)
  for (let i = 0; i < 20; i++) assert.equal(request('2001:db8::1', true), undefined)
  assert.equal(request('2001:db8::2', true).status, 429)
})

test('enabled registration fails readiness before its migration while compatible disabled releases remain ready', async t => {
  for (const enabled of [false, true]) {
    const app = createApp({ q: async options => ({ rows: [readyRow(options.text.includes('registration_schema_version') ? 0 : 1)] }),
      secret: 'synthetic-registration-schema-secret', registrationConfig: { enabled, origin: 'https://example.invalid' }, sendVerification: async () => {} })
    const listener = app.listen(0, '127.0.0.1'); await new Promise(resolve => listener.once('listening', resolve)); t.after(() => new Promise(resolve => listener.close(resolve)))
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/ready`)
    assert.equal(response.status, enabled ? 503 : 200)
  }
})
