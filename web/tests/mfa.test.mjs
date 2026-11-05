import test from 'node:test'
import assert from 'node:assert/strict'
import { mfaRequest } from '../src/mfa.ts'

test('MFA requests translate safe failures without retrying and separate anonymous challenges from active-session expiry', async t => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window
  let calls = 0, expired = 0, nextStatus = 401, nextBody = { error: 'mfaInvalid' }
  globalThis.window = { dispatchEvent: () => { expired++ } }
  globalThis.fetch = async (url, options) => { calls++; assert.match(url, /^\/api\//); assert.equal(options.method, 'POST'); return new Response(JSON.stringify(nextBody), { status: nextStatus }) }
  t.after(() => { globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow })
  const tr = key => 'translated:' + key
  await assert.rejects(mfaRequest('/login/mfa', { challenge: 'synthetic' }, tr, true), /translated:mfaInvalid/)
  assert.equal(calls, 1); assert.equal(expired, 0)
  await assert.rejects(mfaRequest('/me/mfa/enroll', {}, tr), /translated:mfaInvalid/)
  assert.equal(calls, 2); assert.equal(expired, 1)
  nextStatus = 503; nextBody = { error: 'private diagnostic with embedded secret' }
  await assert.rejects(mfaRequest('/login/mfa', {}, tr, true), /translated:mfaFailed/)
  nextStatus = 429; nextBody = { error: 'mfaRateLimited' }
  await assert.rejects(mfaRequest('/login/mfa', {}, tr, true), /translated:mfaRateLimited/)
  assert.equal(calls, 4)
  nextStatus = 200; nextBody = { ok: true }
  assert.deepEqual(await mfaRequest('/login/mfa', {}, tr, true), { ok: true })
})
