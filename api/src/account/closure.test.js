import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { createAccountClosure } from './closure.js'

const hash = bcrypt.hashSync('correct-password', 4)
function setup({ role = 'dev', admins = ['me'], current = hash } = {}) {
  const writes = []
  const query = async () => ({ rows: [{ password_hash: hash }] })
  const tx = async (sql, args) => {
    if (sql.startsWith('SELECT id,role,active,password_hash')) return { rows: [{ id: 'me', role, active: true, password_hash: current }] }
    if (sql.startsWith("SELECT id FROM users WHERE role='Admin'")) return { rows: admins.map(id => ({ id })) }
    writes.push(sql.split(' ').slice(0, 2).join(' ') + ' ' + (sql.match(/^(?:UPDATE|DELETE FROM) (\w+)/)?.[1] || ''))
    return { rows: [{ closed_at: '2026-11-05T00:00:00Z' }], rowCount: 1 }
  }
  return { writes, closure: createAccountClosure({ query, transaction: fn => fn(tx) }) }
}
const user = { id: 'me', email: 'me@example.invalid', role: 'dev' }
const input = { currentPassword: 'correct-password', confirm: 'ME@example.invalid ' }

test('closing requires the current password and the typed email, before any write', async () => {
  for (const bad of [{}, { ...input, currentPassword: '' }, { ...input, confirm: 'other@example.invalid' }, { ...input, currentPassword: 'x'.repeat(1025) }]) {
    const s = setup(); await assert.rejects(s.closure.close(user, bad), { status: 400 }); assert.deepEqual(s.writes, [])
  }
  { const s = setup(); await assert.rejects(s.closure.close(user, { ...input, currentPassword: 'wrong-password' }), { status: 400 }); assert.deepEqual(s.writes, []) }
})
test('a password changed between verification and lock aborts without writes', async () => {
  const s = setup({ current: bcrypt.hashSync('rotated', 4) })
  await assert.rejects(s.closure.close(user, input), { status: 409 }); assert.deepEqual(s.writes, [])
})
test('the last active Admin cannot close; another Admin can', async () => {
  { const s = setup({ role: 'Admin', admins: ['me'] }); await assert.rejects(s.closure.close({ ...user, role: 'Admin' }, input), { status: 409 }); assert.deepEqual(s.writes, []) }
  { const s = setup({ role: 'Admin', admins: ['me', 'other'] }); assert.equal((await s.closure.close({ ...user, role: 'Admin' }, input)).closed, true) }
})
test('closing deactivates, revokes sessions and actions, and trashes owned resources in one transaction', async () => {
  const s = setup(); const result = await s.closure.close(user, input)
  assert.deepEqual(result, { closed: true, closed_at: '2026-11-05T00:00:00Z', retentionDays: 30 })
  assert.deepEqual(s.writes, ['UPDATE users users', 'UPDATE user_sessions user_sessions', 'DELETE FROM account_actions', 'UPDATE projects projects', 'UPDATE blocks blocks', 'UPDATE images images'])
})
test('only Admin reopens, and only valid ids', async () => {
  const s = setup()
  await assert.rejects(s.closure.reopen(user, '11111111-1111-1111-1111-111111111111'), { status: 403 })
  await assert.rejects(s.closure.reopen({ id: 'a', role: 'Admin' }, 'nope'), { status: 404 })
})
