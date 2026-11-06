import test from 'node:test'
import assert from 'node:assert/strict'
import { createAuditStore, auditRetentionDays } from './audit-store.js'
import { securityAudit } from './audit.js'
import { EventEmitter } from 'node:events'

const actor = '11111111-1111-1111-1111-111111111111', request = '33333333-3333-4333-8333-333333333333'

test('durable audit stores only closed fields, sanitizes identifiers and purges at most once per interval', async () => {
  const calls = []
  let now = 0
  const store = createAuditStore({ q: async (sql, args) => { calls.push([sql, args]); return { rows: [] } }, clock: () => now })
  await store.write({ schema: 'sugar.audit.v1', at: '2026-11-06T00:00:00.000Z', actor, operation: 'auth.login', result: 'success', status: 200, request_id: request, email: 'private@example.invalid' })
  await store.write({ at: '2026-11-06T00:00:01.000Z', actor: 'private@example.invalid', operation: 'project.settings', result: 'aborted', status: null, resource: 'not-a-uuid' })
  await store.write({ at: 'x', operation: 'DROP TABLE', result: 'success' })
  const inserts = calls.filter(([sql]) => sql.startsWith('INSERT'))
  assert.deepEqual(inserts.map(([, args]) => args), [
    ['2026-11-06T00:00:00.000Z', request, actor, 'auth.login', 'success', 200, null],
    ['2026-11-06T00:00:01.000Z', null, null, 'project.settings', 'aborted', null, null],
  ])
  assert.equal(JSON.stringify(calls).includes('private@'), false)
  assert.equal(calls.filter(([sql]) => sql.startsWith('DELETE')).length, 1)
  assert.deepEqual(calls.find(([sql]) => sql.startsWith('DELETE'))[1], [auditRetentionDays])
  now = 3600_000
  await store.write({ at: '2026-11-06T01:00:00.000Z', operation: 'auth.logout', result: 'success', status: 200 })
  assert.equal(calls.filter(([sql]) => sql.startsWith('DELETE')).length, 2)
})

test('audit listing is Admin only, bounded and validates filters', async () => {
  const seen = []
  const store = createAuditStore({ q: async (sql, args) => { seen.push(args); return { rows: Array.from({ length: args[3] }, (_, i) => ({ id: String(100 - i) })) } } })
  await assert.rejects(store.list({ role: 'dev' }), { status: 403 })
  await assert.rejects(store.list(null), { status: 403 })
  const page = await store.list({ role: 'Admin' }, { limit: '500', result: 'error', operation: 'auth' })
  assert.deepEqual(seen[0], [null, 'error', 'auth', 101])
  assert.equal(page.events.length, 100); assert.equal(page.next, '1'); assert.equal(page.retentionDays, auditRetentionDays)
  for (const query of [{ before: '0' }, { before: '1;DROP' }, { result: 'ok' }, { operation: "auth' OR 1=1" }, { result: ['error', 'denied'] }])
    await assert.rejects(store.list({ role: 'Admin' }, query), { status: 400 }, JSON.stringify(query))
})

test('audit events carry the server request ID for correlation, never a client-supplied one', () => {
  const records = [], audit = securityAudit({ write: event => records.push(event) })
  for (const requestId of [request, 'client-supplied']) {
    const res = new EventEmitter(); res.locals = {}; res.statusCode = 500
    audit({ path: '/login', method: 'POST', requestId, headers: { 'x-request-id': request } }, res, () => {})
    res.emit('finish')
  }
  assert.equal(records[0].request_id, request)
  assert.equal('request_id' in records[1], false)
})
