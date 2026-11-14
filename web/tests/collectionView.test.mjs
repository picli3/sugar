import test from 'node:test'
import assert from 'node:assert/strict'
import { collectionOrder, collectionPath, emptyCollectionFilters, sortCollection } from '../src/collectionView.ts'
import { usePagedList } from '../src/pagination.ts'

test('header sorting toggles the effective default order and preserves advanced filters', () => {
  const filters = { ...emptyCollectionFilters(), name: 'Sensor', createdFrom: '2026-01-01', maxBytes: '4096' }
  assert.deepEqual(collectionOrder(filters), { sort: 'created', direction: 'desc' })
  const oldest = sortCollection(filters, 'created')
  assert.equal(oldest.direction, 'asc')
  assert.equal(sortCollection(oldest, 'created').direction, 'desc')
  const named = sortCollection(oldest, 'name')
  assert.equal(named.direction, 'asc')
  assert.equal(sortCollection(named, 'name').direction, 'desc')
  assert.equal(sortCollection(named, 'size').direction, 'desc')
  assert.equal(sortCollection(named, 'modified').direction, 'desc')
  for (const sorted of [oldest, named]) {
    assert.equal(sorted.name, filters.name)
    assert.equal(sorted.createdFrom, filters.createdFrom)
    assert.equal(sorted.maxBytes, filters.maxBytes)
  }
})

test('changing collection filters resets continuation and discards a late preceding page', async () => {
  let filters = emptyCollectionFilters()
  const pending = [], calls = []
  const pages = usePagedList(path => {
    calls.push(path)
    return new Promise(resolve => pending.push(resolve))
  }, () => collectionPath('projects', filters), item => item.id)
  const first = pages.first()
  pending[0]({ items: [{ id: 'initial' }], nextCursor: 'old-cursor' })
  await first
  const old = pages.more()
  filters = { ...emptyCollectionFilters(), sort: 'name', direction: 'asc', name: 'A & B' }
  const fresh = pages.first()
  assert.match(calls[2], /name=A\+%26\+B/)
  assert.equal(new URL(calls[2], 'https://sugar.invalid').searchParams.has('cursor'), false)
  pending[2]({ items: [{ id: 'filtered' }], nextCursor: null })
  await fresh
  pending[1]({ items: [{ id: 'stale' }], nextCursor: 'old' })
  await old
  assert.deepEqual(pages.items.value, [{ id: 'filtered' }])
  assert.equal(pages.cursor.value, null)
  assert.equal((calls[2].match(/\?/g) || []).length, 1)
})
