import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { authorizationRequest, stateHash, tokenResult, userToken } from './protocol.js'
import { createGithubBox } from './secrets.js'
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', linkId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const access = 'ghu_' + 'a'.repeat(40), refresh = 'ghr_' + 'b'.repeat(40)

test('GitHub OAuth uses independently random state, S256 PKCE and a fixed same-origin callback', () => {
  const first = authorizationRequest({ clientId: 'Iv1.synthetic', origin: 'https://sugar.example.invalid' }), second = authorizationRequest({ clientId: 'Iv1.synthetic', origin: 'https://sugar.example.invalid' })
  const url = new URL(first.authorizationUrl)
  assert.equal(url.origin, 'https://github.com'); assert.equal(url.pathname, '/login/oauth/authorize')
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/); assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first.state, second.state); assert.notEqual(first.verifier, second.verifier)
  assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(first.verifier).digest('base64url'))
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://sugar.example.invalid/oauth/github/callback')
  assert.equal(url.searchParams.get('scope'), 'offline_access'); assert.equal(url.searchParams.get('prompt'), 'select_account')
  assert.match(stateHash(first.state), /^[a-f0-9]{64}$/); assert.notEqual(stateHash(first.state), first.state)
  for (const origin of ['', 'http://public.example.invalid','https://example.invalid/extra','https://example.invalid/?token=private','https://user:password@example.invalid','https://example.invalid/']) assert.throws(() => authorizationRequest({ clientId: 'Iv1.synthetic', origin }), { code: 'GITHUB_CONFIG_REQUIRED' })
  for (const origin of ['http://localhost:8091','http://127.0.0.1:8091','http://[::1]:8091']) assert.ok(authorizationRequest({ clientId: 'Iv1.synthetic', origin }).authorizationUrl)
})
test('token responses accept only App user tokens and complete bounded expiration/refresh metadata', () => {
  const base = { access_token: access, token_type: 'bearer', scope: '' }
  assert.deepEqual(tokenResult(base), { accessToken: access, refreshToken: null, expiresAt: null, refreshExpiresAt: null })
  const valid = { ...base, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600 }, parsed = tokenResult(valid, 0)
  assert.equal(parsed.expiresAt.getTime(), 28800000); assert.equal(parsed.refreshToken, refresh)
  for (const patch of [{ token_type: 'other' },{ scope: 'repo' },{ error: 'private diagnostic' },{ expires_in: 28800 },{ expires_in: 0 },{ expires_in: 86401 },{ refresh_token: refresh },{ refresh_token_expires_in: -1 },{ expires_in: '28800' }]) assert.throws(() => tokenResult({ ...base, ...patch }))
  for (const value of ['ghs_'+'a'.repeat(40),'ghp_'+'a'.repeat(40),'gho_'+'a'.repeat(40),access+'\r\nInjected: yes',access+'x'.repeat(600),null]) assert.throws(() => userToken(value), { code: 'GITHUB_USER_TOKEN_INVALID' })
})
test('GitHub credentials encrypt with account, connection generation and purpose isolation', () => {
  const box = createGithubBox('09'.repeat(32)), scope = { userId, linkId, purpose: 'access' }, first = box.encrypt(scope, access), second = box.encrypt(scope, access)
  assert.equal(box.available, true); assert.notDeepEqual(first, second); assert.equal(box.decrypt(scope, first), access)
  assert.equal(JSON.stringify(first).includes(access), false); assert.deepEqual(JSON.parse(JSON.stringify(box)), { available: true })
  for (const wrong of [{ ...scope, userId: linkId },{ ...scope, linkId: userId },{ ...scope, purpose: 'refresh' }]) assert.throws(() => box.decrypt(wrong, first), { code: 'GITHUB_SECRET_INVALID' })
  for (const wrong of [null, { ...first, v: 2 },{ ...first, data: '00' },{ ...first, tag: '0'.repeat(32) },{ ...first, extra: true }]) assert.throws(() => box.decrypt(scope, wrong), { code: 'GITHUB_SECRET_INVALID' })
  assert.throws(() => createGithubBox('10'.repeat(32)).decrypt(scope, first), { code: 'GITHUB_SECRET_INVALID' })
  assert.throws(() => box.encrypt(scope, 'x'.repeat(1025)), { code: 'GITHUB_SECRET_INVALID' })
  assert.throws(() => createGithubBox('').encrypt(scope, access), { code: 'GITHUB_KEY_REQUIRED' })
})
