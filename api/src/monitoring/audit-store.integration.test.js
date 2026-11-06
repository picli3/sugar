import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { initAuditDb, createAuditStore } from './audit-store.js'

// Explicit opt-in: disposable database only; builds and drops its own schema.
const url = process.env.API_TEST_DATABASE_URL
test('durable audit table enforces its closed shape, purges by age and lists for Admin', { skip: !url }, async t => {
  const root = new pg.Pool({ connectionString: url }), schema = 'audit_' + crypto.randomBytes(8).toString('hex')
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,email text)')
  await initAuditDb(q); await initAuditDb(q)
  const admin = crypto.randomUUID(), other = crypto.randomUUID()
  await q('INSERT INTO users VALUES($1,$2),($3,$4)', [admin, 'admin@example.invalid', other, 'other@example.invalid'])
  await q("INSERT INTO audit_events(at,operation,result) VALUES(now()-interval '181 days','auth.login','success'),(now()-interval '179 days','auth.login','denied')")
  for (const bad of ["('DROP TABLE','success',200)", "('auth.login','ok',200)", "('auth.login','success',42)"])
    await assert.rejects(q('INSERT INTO audit_events(operation,result,status) VALUES' + bad), { code: '23514' }, bad)
  const store = createAuditStore({ q })
  const resource = crypto.randomUUID(), request = crypto.randomUUID()
  await store.write({ at: new Date().toISOString(), request_id: request, actor: admin, operation: 'project.settings', result: 'success', status: 200, resource })
  await store.write({ at: new Date().toISOString(), actor: other, operation: 'auth.password_change', result: 'error', status: 500 })
  const all = (await q('SELECT operation,result,at < now()-interval \'180 days\' AS expired FROM audit_events ORDER BY id')).rows
  assert.deepEqual(all.map(row => [row.operation, row.result, row.expired]), [['auth.login', 'denied', false], ['project.settings', 'success', false], ['auth.password_change', 'error', false]])
  const page = await store.list({ role: 'Admin' }, { limit: 2 })
  assert.deepEqual(page.events.map(event => [event.operation, event.actor_email]), [['auth.password_change', 'other@example.invalid'], ['project.settings', 'admin@example.invalid']])
  assert.equal(page.events[1].request_id, request); assert.equal(page.events[1].resource, resource)
  const rest = await store.list({ role: 'Admin' }, { before: page.next })
  assert.deepEqual(rest.events.map(event => event.result), ['denied']); assert.equal(rest.next, null)
  assert.deepEqual((await store.list({ role: 'Admin' }, { operation: 'auth' })).events.map(event => event.operation), ['auth.password_change', 'auth.login'])
  assert.deepEqual((await store.list({ role: 'Admin' }, { result: 'error' })).events.length, 1)
})
