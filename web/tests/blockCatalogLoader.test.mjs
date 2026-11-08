import test from 'node:test'
import assert from 'node:assert/strict'
import { useBlockCatalog } from '../src/blockCatalogLoader.ts'

test('catalog automatically traverses short pages and retries the failed cursor without losing rows', async () => {
  const paths = [], first = { id: 'a' }, second = { id: 'b' }
  let fail = true
  const catalog = useBlockCatalog(async path => {
    paths.push(path)
    if (!path.includes('cursor')) return { items: [first], nextCursor: 'a' }
    if (fail) throw Error('temporary failure')
    return { items: [second], nextCursor: null }
  }, async () => {})
  await catalog.load()
  assert.equal(catalog.status.value, 'error')
  assert.deepEqual(catalog.items.value, [first])
  fail = false
  await catalog.load()
  assert.equal(catalog.status.value, 'complete')
  assert.deepEqual(catalog.items.value, [first, second])
  assert.equal(paths[1], paths[2])
  assert.match(paths[0], /limit=100$/)
})

test('changing identity aborts the old traversal and ignores late results', async () => {
  const pending = []
  const catalog = useBlockCatalog((path, signal) => new Promise(resolve => pending.push({ path, signal, resolve })), async () => {})
  const old = catalog.load()
  catalog.reset()
  assert.equal(pending[0].signal.aborted, true)
  const current = catalog.load()
  pending[1].resolve({ items: [{ id: 'current' }], nextCursor: null })
  await current
  pending[0].resolve({ items: [{ id: 'private' }], nextCursor: 'private' })
  await old
  assert.equal(pending.length, 2)
  assert.deepEqual(catalog.items.value, [{ id: 'current' }])
})
