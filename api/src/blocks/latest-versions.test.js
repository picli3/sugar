import test from 'node:test'
import assert from 'node:assert/strict'
import { createBlockService } from './service.js'

const a = '11111111-1111-1111-1111-111111111111', b = '22222222-2222-2222-2222-222222222222'
test('latest versions validate input and return only what the repository authorizes', async () => {
  let seen
  const service = createBlockService({ blocks: { latestVersions: async (ids, user) => { seen = { ids, user }; return [{ id: a, latest_version: 4 }] } } })
  const user = { id: 'u', role: 'dev' }
  assert.deepEqual(await service.latestVersions(user, { ids: [a, b] }), { versions: { [a]: 4 } })
  assert.deepEqual(seen, { ids: [a, b], user })
  assert.deepEqual(await service.latestVersions(user, { ids: [] }), { versions: {} })
  for (const ids of [undefined, 'x', [a, a], ['not-a-uuid'], ['AAAAAAAA-1111-1111-1111-111111111111'], Array.from({ length: 501 }, (_, i) => `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`)]) {
    await assert.rejects(service.latestVersions(user, { ids }), { status: 400 })
  }
})
