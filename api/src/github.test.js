import test from 'node:test'
import assert from 'node:assert/strict'
import { enqueue, syncOne } from './github.js'

test('only projects with an explicit repository enqueue synchronization jobs', async () => {
  const writes = [], query = async (...args) => { writes.push(args) }
  await enqueue('block', 'b1', 1, 'name: block', query)
  await enqueue('project', 'p1', 1, 'name: project', query)
  assert.equal(writes.length, 0)
  await enqueue('project', 'p1', 2, 'name: project', query, { repository: 'team/design', branch: 'hardware' })
  assert.deepEqual(writes[0][1], ['project', 'p1', 2, 'name: project', 'team/design', 'hardware'])
})

test('worker entry accepts only the scoped integration and does not resolve global installation credentials', async () => {
  let ticks = 0
  await syncOne({ integration: { worker: { tick: async () => { ticks++ } } } })
  assert.equal(ticks, 1)
})
