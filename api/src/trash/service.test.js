import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrashService } from './service.js'
import { trashRetentionDays } from './repository.js'

const id = '11111111-1111-1111-1111-111111111111'
const owner = { id: 'owner', role: 'dev' }, other = { id: 'other', role: 'dev' }, admin = { id: 'admin', role: 'Admin' }, viewer = { id: 'owner', role: 'view' }
function setup(item) {
  const calls = [], tx = async () => ({ rows: [] })
  const trash = {
    async find(kind, itemId, execute, lock) { calls.push(['find', kind, itemId, execute === tx, lock]); return item && { ...item } },
    async trash(kind, itemId, execute) { calls.push(['trash', kind, itemId, execute === tx]); return 1 },
    async restore(kind, itemId, execute) { calls.push(['restore', kind, itemId, execute === tx]); return 1 },
    async purge(kind, itemId, execute) { calls.push(['purge', kind, itemId, execute === tx]); return 1 },
    async page() { return [] },
  }
  const service = createTrashService({ trash, transaction: fn => fn(tx) })
  return { service, calls, writes: () => calls.filter(([op]) => op !== 'find') }
}
const active = { id, name: 'Placa', owner_id: 'owner', deleted_at: null, purgeable: false }
const trashed = { ...active, deleted_at: new Date(), purge_after: '2026-12-05T00:00:00.000000Z' }
const old = { ...trashed, purgeable: true }

test('owners and Admin can trash; other accounts and readers cannot, without revealing the resource', async () => {
  for (const user of [owner, admin]) { const s = setup(active); await s.service.trash('project', id, user); assert.deepEqual(s.writes(), [['trash', 'project', id, true]]); assert.equal(s.calls[0][4], true) }
  { const s = setup(active); await assert.rejects(s.service.trash('block', id, other), { status: 404 }); assert.deepEqual(s.writes(), []) }
  { const s = setup(active); await assert.rejects(s.service.trash('image', id, viewer), { status: 403 }); assert.deepEqual(s.writes(), []) }
  { const s = setup({ ...active, owner_id: null }); await assert.rejects(s.service.trash('block', id, owner), { status: 404 }) } // shared catalog
  { const s = setup({ ...active, owner_id: null }); await s.service.trash('block', id, admin); assert.equal(s.writes().length, 1) }
})
test('trashing twice, unknown kinds and malformed ids are rejected without writes', async () => {
  { const s = setup(trashed); await assert.rejects(s.service.trash('project', id, owner), { status: 404 }); assert.deepEqual(s.writes(), []) }
  { const s = setup(active); await assert.rejects(s.service.trash('user', id, admin), { status: 404 }); assert.deepEqual(s.calls, []) }
  { const s = setup(active); await assert.rejects(s.service.restore('project', 'not-a-uuid', owner), { status: 404 }); assert.deepEqual(s.writes(), []) }
})
test('restore requires the item to be in the trash and returns it', async () => {
  { const s = setup(trashed); assert.deepEqual(await s.service.restore('image', id, owner), { kind: 'image', id, name: 'Placa' }); assert.deepEqual(s.writes(), [['restore', 'image', id, true]]) }
  { const s = setup(active); await assert.rejects(s.service.restore('image', id, owner), { status: 409 }); assert.deepEqual(s.writes(), []) }
  { const s = setup(trashed); await assert.rejects(s.service.restore('image', id, other), { status: 404 }); assert.deepEqual(s.writes(), []) }
})
test(`purge needs ${trashRetentionDays} days in the trash and the exact name, for the owner or Admin`, async () => {
  { const s = setup(active); await assert.rejects(s.service.purge('project', id, owner, { confirm: 'Placa' }), { status: 409 }); assert.deepEqual(s.writes(), []) }
  { const s = setup(trashed); await assert.rejects(s.service.purge('project', id, owner, { confirm: 'Placa' }), err => err.status === 409 && err.message.includes(trashed.purge_after)); assert.deepEqual(s.writes(), []) }
  for (const confirm of [undefined, 'placa', 'Placa ', id]) { const s = setup(old); await assert.rejects(s.service.purge('project', id, owner, { confirm }), { status: 400 }); assert.deepEqual(s.writes(), []) }
  { const s = setup(old); await assert.rejects(s.service.purge('project', id, other, { confirm: 'Placa' }), { status: 404 }); assert.deepEqual(s.writes(), []) }
  for (const user of [owner, admin]) { const s = setup(old); assert.deepEqual(await s.service.purge('block', id, user, { confirm: 'Placa' }), { kind: 'block', id, purged: true }); assert.deepEqual(s.writes(), [['purge', 'block', id, true]]) }
})
test('readers cannot list the trash', async () => {
  await assert.rejects(setup(null).service.page(viewer, {}), { status: 403 })
  assert.deepEqual(await setup(null).service.page(owner, {}), { items: [], nextCursor: null })
})
