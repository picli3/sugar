import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createGithubClient } from './client.js'
const token = 'ghu_' + 'a'.repeat(40), refresh = 'ghr_' + 'b'.repeat(40)
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target = { installationId: '7', repositoryId: '8', repository: 'fixture/repo', branch: 'design/v2' }
const installation = { id: 7, account: { id: 9, login: 'fixture' }, permissions: { contents: 'write' }, suspended_at: null }
const repository = { id: 8, owner: { id: 9 }, full_name: 'fixture/repo', default_branch: 'main', private: true, permissions: { push: true }, archived: false, disabled: false }
const response = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
function fixture(overrides = {}) {
  const calls = [], client = createGithubClient({ clientId: 'Iv1.synthetic', clientSecret: 'synthetic-client-secret', origin: 'https://sugar.example.invalid', request: async (url, options) => {
    calls.push([url, options]); assert.equal(options.redirect, 'error')
    const path = new URL(url).pathname
    if (overrides[path]) return overrides[path](url, options)
    if (path === '/user/installations') return response({ total_count: 1, installations: [installation] })
    if (path === '/user/installations/7/repositories') return response({ total_count: 1, repositories: [repository] })
    if (path === '/repos/fixture/repo/branches/design%2Fv2') return response({ name: 'design/v2' })
    if (path.endsWith('.yaml')) return options.method === 'PUT' ? response({ commit: { sha: 'c'.repeat(40) } }) : response(null, 404)
    throw Error('Unexpected provider request')
  } })
  return { client, calls }
}
test('writes revalidate the SAME user token, installation membership, repository rights and existing branch', async () => {
  const { client, calls } = fixture(), result = await client.writeRevision(token, target, { id, revision: 1, yaml: 'name: synthetic' })
  assert.equal(result.commitSha, 'c'.repeat(40)); assert.equal(calls.length, 5)
  for (const [, options] of calls) assert.equal(options.headers.Authorization, 'Bearer ' + token)
  const [url, options] = calls.at(-1); assert.equal(url, `https://api.github.com/repos/fixture/repo/contents/projects/${id}/revision-1.yaml`)
  assert.deepEqual(JSON.parse(options.body), { message: `project ${id} revision 1`, content: Buffer.from('name: synthetic').toString('base64'), branch: 'design/v2' })
})
test('no write uses another installation, a renamed/moved/read-only repository, revoked rights or missing branch', async () => {
  for (const [path, body, status, code] of [
    ['/user/installations',{ total_count: 0, installations: [] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations',{ total_count: 1, installations: [{ ...installation, suspended_at: '2026-01-01' }] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations',{ total_count: 1, installations: [{ ...installation, permissions: { contents: 'read' } }] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations/7/repositories',{ total_count: 1, repositories: [{ ...repository, owner: { id: 10 } }] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations/7/repositories',{ total_count: 1, repositories: [{ ...repository, full_name: 'fixture/renamed' }] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations/7/repositories',{ total_count: 1, repositories: [{ ...repository, permissions: { push: false } }] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations/7/repositories',{ total_count: 1, repositories: [{ ...repository, archived: true }] },200,'GITHUB_ACCESS_DENIED'],
    ['/user/installations/7/repositories',{ private: 'sensitive diagnostic' },401,'GITHUB_USER_REVOKED'],
    ['/repos/fixture/repo/branches/design%2Fv2',null,404,'GITHUB_BRANCH_MISSING'],
  ]) {
    const { client, calls } = fixture({ [path]: () => response(body, status) })
    await assert.rejects(client.writeRevision(token, target, { id, revision: 1, yaml: 'name: synthetic' }), { code })
    assert.equal(calls.filter(([, options]) => options.method === 'PUT').length, 0)
  }
  const { client, calls } = fixture(); await assert.rejects(client.writeRevision('ghs_'+'a'.repeat(40), target, { id, revision: 1, yaml: 'fixture' }), { code: 'GITHUB_USER_TOKEN_INVALID' }); assert.equal(calls.length, 0)
})
test('an uncertain prior commit is idempotent; different content at a revision is never overwritten', async () => {
  const yaml = 'name: unchanged', sha = crypto.createHash('sha1').update('blob ' + Buffer.byteLength(yaml) + '\0').update(yaml).digest('hex'), path = `/repos/fixture/repo/contents/projects/${id}/revision-1.yaml`
  for (const [existing, expected] of [[sha, null],['d'.repeat(40),'GITHUB_REVISION_CONFLICT']]) {
    const { client, calls } = fixture({ [path]: () => response({ type: 'file', sha: existing }) })
    if (expected) await assert.rejects(client.writeRevision(token, target, { id, revision: 1, yaml }), { code: expected })
    else assert.deepEqual(await client.writeRevision(token, target, { id, revision: 1, yaml }), { commitSha: null, unchanged: true })
    assert.equal(calls.some(([, options]) => options.method === 'PUT'), false)
  }
})
test('OAuth sends PKCE/client credentials only in JSON to the fixed endpoint, refresh and scoped revoke never retry', async () => {
  const calls = [], client = createGithubClient({ clientId: 'Iv1.synthetic', clientSecret: 'synthetic-client-secret', origin: 'https://sugar.example.invalid', request: async (url, options) => {
    calls.push([url, options]); assert.equal(new URL(url).search, ''); assert.equal(options.redirect, 'error')
    if (options.method === 'DELETE') { assert.equal(url, 'https://api.github.com/applications/Iv1.synthetic/token'); return response(null, 204) }
    assert.equal(url, 'https://github.com/login/oauth/access_token'); assert.equal(options.headers.Accept, 'application/json')
    return response({ token_type: 'bearer', scope: '', access_token: token, refresh_token: refresh, expires_in: 28800, refresh_token_expires_in: 15897600 })
  } })
  const verifier = 'v'.repeat(43)
  await client.exchange({ code: 'synthetic-code', verifier }); await client.refresh(refresh); await client.revoke(token)
  assert.equal(JSON.parse(calls[0][1].body).code_verifier, verifier)
  assert.equal(JSON.parse(calls[0][1].body).redirect_uri, 'https://sugar.example.invalid/oauth/github/callback')
  assert.equal(JSON.parse(calls[1][1].body).grant_type, 'refresh_token'); assert.equal(calls.length, 3)
})
test('provider budgets bound streams, malformed JSON, rate limits, hanging fetch/read and diagnostics', async () => {
  for (const [provider, code] of [
    [() => response({ private: 'token diagnostic' },403),'GITHUB_ACCESS_DENIED'],
    [() => response({},403,{ 'x-ratelimit-remaining': '0' }),'GITHUB_RATE_LIMITED'],
    [() => new Response('bad',{ headers: { 'content-type': 'application/json' } }),'GITHUB_RESPONSE_INVALID'],
    [() => new Response('private',{ headers: { 'content-type': 'text/html' } }),'GITHUB_RESPONSE_INVALID'],
    [() => new Response('x',{ headers: { 'content-type': 'application/json', 'content-length': '99999999' } }),'GITHUB_RESPONSE_TOO_LARGE'],
    [() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4*1024*1024+1)); c.close() } }),{ headers:{'content-type':'application/json'} }),'GITHUB_RESPONSE_TOO_LARGE'],
    [() => new Promise(() => {}),'GITHUB_TIMEOUT'],
    [() => new Response(new ReadableStream({ pull() { return new Promise(() => {}) } }),{ headers:{'content-type':'application/json'} }),'GITHUB_TIMEOUT'],
    [() => { throw Object.assign(Error('private password diagnostic'), { code: 'GITHUB_FAKE_SECRET' }) },'GITHUB_UNAVAILABLE'],
  ]) {
    let calls=0
    const client=createGithubClient({timeoutMs:20,request:async()=>{calls++;return provider()}})
    await assert.rejects(client.identity(token),e=>{assert.equal(e.code,code);assert.equal(e.message.includes('private'),false);return true});assert.equal(calls,1)
  }
})
test('catalog pagination is bounded and never silently returns more than its policy allows', async () => {
  let count=0
  const client=createGithubClient({request:async url=>{count++;const page=Number(new URL(url).searchParams.get('page'));return response({total_count:1001,installations:Array.from({length:50},(_,i)=>({...installation,id:(page-1)*50+i+1}))})}})
  await assert.rejects(client.installations(token),{code:'GITHUB_CATALOG_TOO_LARGE'});assert.equal(count,20)
})

test('one monotonic budget covers all catalog pages even if wall clock moves backwards', async () => {
  let calls = 0
  const client = createGithubClient({ timeoutMs: 25, clock: () => -100000, request: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 10))
    return response({ total_count: 1000, installations: Array.from({ length: 50 }, (_, i) => ({ ...installation, id: i + calls * 50 })) })
  } })
  await assert.rejects(client.installations(token), { code: 'GITHUB_TIMEOUT' }); assert.ok(calls <= 3)
})

test('a private target becoming public needs renewed explicit publication consent', async () => {
  const { client, calls } = fixture({ '/user/installations/7/repositories': () => response({ total_count: 1, repositories: [{ ...repository, private: false }] }) })
  await assert.rejects(client.writeRevision(token, target, { id, revision: 1, yaml: 'name: confidential' }), { code: 'GITHUB_REPOSITORY_PUBLIC' })
  assert.equal(calls.some(([url]) => url.includes('/contents/')), false)
  await client.writeRevision(token, { ...target, allowPublic: true }, { id, revision: 1, yaml: 'name: publication consented' })
  assert.equal(calls.filter(([, options]) => options.method === 'PUT').length, 1)
})
