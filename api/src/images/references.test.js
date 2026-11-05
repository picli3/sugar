import test from 'node:test'
import assert from 'node:assert/strict'
import { imageIds } from './references.js'
import { createImageService } from './service.js'
const id = '11111111-1111-1111-1111-111111111111', path = `/api/images/${id}/content`
test('only canonical image fields establish local resource grants; arbitrary text and remote URLs do not', () => {
  assert.deepEqual(imageIds(JSON.stringify({ nodes: [{ block: { image: path } }, { block: { image: path } }], notes: path }), 'project'), [id])
  assert.deepEqual(imageIds(JSON.stringify({ image: 'https://example.com' + path, notes: path }), 'block'), [])
  assert.deepEqual(imageIds(JSON.stringify({ image: path + '?share=invalid' }), 'block'), [])
})
test('attachment rejection cannot create references and all queries use the supplied transaction', async () => {
  let writes = 0
  const tx = async sql => { if (/^SELECT/.test(sql)) return { rows: [{ id, trashed: false, referenced: false }] }; writes++; return { rows: [] } }
  const service = createImageService({ content: async (imageId, user, execute) => { assert.equal(imageId, id); assert.equal(user.id, 'actor'); assert.equal(execute, tx); return null } })
  await assert.rejects(service.attach(JSON.stringify({ image: path }), 'block', id, { id: 'actor' }, tx), { status: 404 })
  assert.equal(writes, 0)
})
const recorder = row => {
  const calls = []
  const tx = async (sql, args) => { calls.push([sql, args]); return /^SELECT/.test(sql) ? { rows: row ? [row] : [] } : { rows: [] } }
  return { calls, tx, inserted: () => calls.filter(([sql]) => /^INSERT INTO image_references/.test(sql)).map(([, args]) => args[0]) }
}
const readable = createImageService({ content: async () => ({ mime: 'image/png' }) })
test('a purged or unknown image id grants nothing and does not block saving', async () => {
  const r = recorder(null)
  await readable.attach(JSON.stringify({ image: path }), 'block', id, { id: 'actor' }, r.tx)
  assert.deepEqual(r.inserted(), [])
  assert.match(r.calls[0][0], /FOR KEY SHARE/)
})
test('a trashed image keeps existing references but cannot be newly attached', async () => {
  const kept = recorder({ id, trashed: true, referenced: true })
  await readable.attach(JSON.stringify({ image: path }), 'block', id, { id: 'actor' }, kept.tx)
  assert.deepEqual(kept.inserted(), [id])
  const fresh = recorder({ id, trashed: true, referenced: false })
  await assert.rejects(readable.attach(JSON.stringify({ image: path }), 'block', id, { id: 'actor' }, fresh.tx), { status: 404 })
  assert.deepEqual(fresh.inserted(), [])
})
