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

test('worker publishes to each project repository and branch without reading global settings', async () => {
  const keys = ['GITHUB_APP_ID','GITHUB_INSTALLATION_ID','GITHUB_PRIVATE_KEY']
  const previous = keys.map(k => process.env[k])
  keys.forEach(k => { process.env[k] = 'test-only' })
  try {
    for (const [repository, branch] of [['owner/one', 'main'], ['another/two', 'design/v2']]) {
      const requests = [], updates = []
      await syncOne({
        query: async (sql, args) => {
          assert.doesNotMatch(sql, /settings/)
          if (sql.startsWith('SELECT')) {
            assert.match(sql, /kind='project'/)
            assert.match(sql, /target_repository IS NOT NULL/)
            return { rows: [{ id: 42, kind: 'project', record_id: 'p1', revision: 3, yaml: 'name: project', target_repository: repository, target_branch: branch }] }
          }
          updates.push([sql,args]); return { rows: [] }
        },
        authenticate: () => async () => ({ token: 'fake-token' }),
        request: async (url, options) => {
          requests.push([url,options])
          return options.method === 'PUT' ? { ok:true, json:async()=>({commit:{sha:'verified'}}) } : { ok:false, status:404 }
        }
      })
      assert.equal(requests[0][0], `https://api.github.com/repos/${repository}/contents/projects/p1/revision-3.yaml?ref=${encodeURIComponent(branch)}`)
      assert.equal(requests[1][0], `https://api.github.com/repos/${repository}/contents/projects/p1/revision-3.yaml`)
      assert.equal(JSON.parse(requests[1][1].body).branch, branch)
      assert.equal(Buffer.from(JSON.parse(requests[1][1].body).content,'base64').toString(), 'name: project')
      assert.deepEqual(updates[0][1], [42,'verified'])
    }
  } finally { keys.forEach((k,i)=> { if(previous[i]===undefined) delete process.env[k]; else process.env[k]=previous[i] }) }
})

test('worker rejects excessive commit metadata and bounds retry exponent before evaluation', async () => {
  const keys = ['GITHUB_APP_ID','GITHUB_INSTALLATION_ID','GITHUB_PRIVATE_KEY']
  const previous = keys.map(key => process.env[key])
  keys.forEach(key => { process.env[key] = 'test-only' })
  try {
    for (const sha of ['ñ'.repeat(65), { unexpected: 'metadata' }]) {
      const updates = []
      await syncOne({
        query: async (sql, args) => {
          if (sql.startsWith('SELECT')) return { rows: [{ id: 1, kind: 'project', record_id: 'p', revision: 1, yaml: 'name: fixture', target_repository: 'fixture/repo' }] }
          updates.push([sql, args]); return { rows: [] }
        },
        authenticate: () => async () => ({ token: 'fake-token' }),
        request: async (_url, options) => options.method === 'PUT' ? { ok: true, json: async () => ({ commit: { sha } }) } : { ok: false, status: 404 },
      })
      assert.equal(updates.length, 1)
      assert.doesNotMatch(updates[0][0], /status='synced'/)
      assert.match(updates[0][0], /POWER\(2, LEAST\(attempts,12\)\)/)
      assert.deepEqual(updates[0][1], [1, 'UNEXPECTED_ERROR'])
    }
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }) }
})
