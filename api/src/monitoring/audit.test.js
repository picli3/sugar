import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { securityAudit } from './audit.js'

const actor = '11111111-1111-1111-1111-111111111111', resource = '22222222-2222-2222-2222-222222222222'
function finish(audit, { path = '/login', method = 'POST', status = 200, user, localActor } = {}) {
  const req = { path, method, user, body: { actor, password: 'synthetic-private-password' }, headers: { cookie: 'synthetic-private-cookie' }, originalUrl: '/private?token=synthetic-private-link' }
  const res = new EventEmitter()
  res.locals = { auditActor: localActor }; res.statusCode = status
  let continued = false
  audit(req, res, () => { continued = true })
  assert(continued)
  res.emit('finish'); res.emit('finish')
}

test('audit emits a closed schema once, with trusted actor and safe resource, never body/headers/URL', () => {
  const records = []
  const audit = securityAudit({ write: event => records.push(event), now: () => '2026-11-03T00:00:00.000Z' })
  finish(audit, { path: `/projects/${resource}/settings`, method: 'PATCH', user: { id: actor, email: 'private@example.invalid' } })
  assert.deepEqual(records, [{ schema: 'sugar.audit.v1', at: '2026-11-03T00:00:00.000Z', actor, operation: 'project.settings', result: 'success', status: 200, resource }])
  assert(!JSON.stringify(records).includes('synthetic-private'))
})

test('failed/anonymous actors cannot be supplied through the body or forged identifiers', () => {
  const records = [], audit = securityAudit({ write: event => records.push(event) })
  finish(audit, { status: 401 })
  finish(audit, { status: 500, user: { id: 'private@example.invalid' } })
  finish(audit, { localActor: actor })
  assert.deepEqual(records.map(event => [event.actor, event.result]), [[null, 'denied'], [null, 'error'], [actor, 'success']])
})

test('case and encoded UUIDs cannot omit the event; session IDs are never recorded', () => {
  const records = [], audit = securityAudit({ write: event => records.push(event) })
  finish(audit, { path: `/UsErS/${resource.toUpperCase().replace('2', '%32')}`, method: 'PATCH', user: { id: actor } })
  assert.equal(records[0].operation, 'user.update')
  assert.equal(records[0].resource, resource)
  finish(audit, { path: `/me/sessions/${resource}`, method: 'DELETE', user: { id: actor } })
  assert.equal(records[1].operation, 'auth.session_revoke')
  assert.equal(records[1].resource, undefined)
})

test('only selected security writes are audited; public share tokens, polling and reads are excluded', () => {
  const records = [], audit = securityAudit({ write: event => records.push(event) })
  for (const path of ['/health', '/ready', '/users', '/shared/synthetic-private-token', `/projects/${resource}`]) finish(audit, { path, method: 'GET' })
  finish(audit, { path: '/users/private@example.invalid', method: 'PATCH' })
  assert.deepEqual(records, [])
  for (const [path, method] of [['/me/password', 'POST'], ['/ai', 'PUT'], ['/ai/quotas', 'PUT'], ['/users', 'POST'], [`/users/${resource}`, 'DELETE'], [`/projects/${resource}/members/${actor}`, 'DELETE']]) finish(audit, { path, method, user: { id: actor }, status: 403 })
  assert.equal(records.length, 6)
  assert(records.every(event => event.result === 'denied' && event.actor === actor))
})

test('a failing simulated writer does not change HTTP behavior or print its diagnostic', async t => {
  const saved = console.error, logs = []
  console.error = (...parts) => logs.push(parts.join(' '))
  t.after(() => { console.error = saved })
  for (const asynchronous of [false, true]) {
    const write = () => { if (asynchronous) return Promise.reject(Error('synthetic-private-diagnostic')); throw Error('synthetic-private-diagnostic') }
    finish(securityAudit({ write }))
  }
  await tick()
  assert.deepEqual(logs, ['Audit output failed: UNEXPECTED_ERROR', 'Audit output failed: UNEXPECTED_ERROR'])
})

test('an aborted connection records an attempt once without claiming a successful mutation', () => {
  const records = [], res = new EventEmitter()
  res.locals = {}; res.statusCode = 200; res.writableFinished = false
  securityAudit({ write: event => records.push(event) })({ method: 'POST', path: '/users', user: { id: actor } }, res, () => {})
  res.emit('close'); res.emit('finish'); res.emit('close')
  assert.equal(records.length, 1)
  assert.equal(records[0].actor, actor)
  assert.equal(records[0].result, 'aborted')
  assert.equal(records[0].status, null)
})

test('GitHub connection audit records only the authenticated actor and a fixed operation', () => {
  const records=[],audit=securityAudit({write:event=>records.push(event)})
  for (const operation of ['authorize','complete','disconnect']) finish(audit,{path:'/me/github/'+operation,method:'POST',user:{id:actor}})
  assert.deepEqual(records.map(e=>e.operation),['auth.github_begin','auth.github_complete','auth.github_disconnect'])
  assert.equal(JSON.stringify(records).includes('synthetic-private'),false)
  assert.ok(records.every(e=>!Object.hasOwn(e,'resource')))
})
