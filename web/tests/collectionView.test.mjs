import test from 'node:test'
import assert from 'node:assert/strict'
import { collectionPath, emptyCollectionFilters } from '../src/collectionView.ts'
import { usePagedList } from '../src/pagination.ts'

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
