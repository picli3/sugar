import test from 'node:test'
import assert from 'node:assert/strict'
import { aiApi, aiMessages } from '../src/ai.ts'

test('AI maps shared storage admission errors to actionable bilingual messages without retry', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  for (const [status, code, expected] of [[409,'storageQuotaExceeded','aiStorageQuota'],[503,'storageUnavailable','aiStorageUnavailable'],[429,null,'aiUserQuota']]) {
    let calls = 0
    globalThis.fetch = async (path, options) => {
      calls++; assert.equal(path, '/api/projects/p/analyses'); assert.equal(options.method, 'POST')
      return new Response(JSON.stringify({ code, error: code ? 'Server translated error' : expected }), { status })
    }
    await assert.rejects(aiApi('/projects/p/analyses', 'POST', { requestId: 'fixture' }), { message: expected })
    assert.equal(calls, 1)
    for (const language of ['es','en']) assert.ok(aiMessages[language][expected])
  }
})
