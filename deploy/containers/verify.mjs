// Executed only inside disposable Compose, as the image's unprivileged user.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { q, pool, transaction } from '/app/src/db.js'
import { syncOne, enqueue } from '/app/src/github.js'
import { createGithubIntegration } from '/app/src/github-link/integration.js'
import { createGithubClient } from '/app/src/github-link/client.js'
import { loadSecretFiles } from '/app/src/config/secrets.js'
import { verifyRuntime } from '/app/src/database/access.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='
let cookie
async function request(path, body, method = body ? 'POST' : 'GET', expected = 200) {
  const response = await fetch('http://web/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  assert.equal(response.status, expected, path)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
  assert.equal(response.headers.get('etag'), null)
  const result = await response.json()
  if (path === '/login') cookie = response.headers.get('set-cookie').split(';')[0]
  return result
}

try {
  await verifyRuntime(q)
  assert.equal((await q('SELECT current_user')).rows[0].current_user, 'sugar_runtime')
  for (const sql of ['CREATE TABLE forbidden_table(id int)', 'CREATE ROLE forbidden_role', 'SET ROLE designer', 'DROP TABLE users', 'TRUNCATE users', 'CREATE TEMP TABLE forbidden_temp(id int)']) {
    await assert.rejects(q(sql), { code: '42501' })
  }
  assert.equal(process.env.ADMIN_PASSWORD, undefined)
  await q("INSERT INTO future_privilege_fixture(value) VALUES('runtime default grants')")
  assert((await q('SELECT * FROM future_privilege_fixture')).rows.length > 0)
  assert.equal(process.getuid(), 1000)
  assert.equal(process.getgid(), 1000)
  for (const path of ['/proc/self/status', '/proc/1/status']) {
    const status = fs.readFileSync(path, 'utf8')
    assert.match(status, /^Uid:\s+1000\s+1000\s+1000\s+1000$/m)
    assert.match(status, /^CapEff:\s+0+$/m)
    assert.match(status, /^NoNewPrivs:\s+1$/m)
  }
  assert.equal(fs.statSync('/app/src/server.js').uid, 0)
  for (const path of ['/app/forbidden', '/etc/forbidden', '/home/node/forbidden']) {
    assert.throws(() => fs.writeFileSync(path, 'blocked'), error => ['EROFS', 'EACCES'].includes(error.code))
  }
  const secret = '/tmp/private-fixture'
  fs.writeFileSync(secret, 'synthetic-jwt-secret-at-least-thirty-two-bytes', { mode: 0o600 })
  const env = { JWT_SECRET_FILE: secret }
  loadSecretFiles(env)
  assert.match(env.JWT_SECRET, /^synthetic-/)
  fs.unlinkSync(secret)
  assert(fs.statfsSync('/tmp').blocks * fs.statfsSync('/tmp').bsize <= 16 * 1024 * 1024)
  const rootPage = await fetch('http://web/')
  assert.equal(rootPage.status, 200)
  const html = await rootPage.text()
  assert.match(html, /Sugar/)
  assert.equal(rootPage.headers.get('cache-control'), 'private, no-store')
  assert.equal(rootPage.headers.get('x-frame-options'), 'DENY')
  assert.match(rootPage.headers.get('content-security-policy'), /script-src 'self'/)
  assert.match(rootPage.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/)
  const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1]
  const script = await fetch('http://web' + asset)
  assert.equal(script.status, 200)
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff')
  const missing = await fetch('http://web/assets/not-present.js')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'private, no-store')
  assert.equal(missing.headers.get('x-frame-options'), 'DENY')
  const denied = await fetch('http://web/api/logout', { method: 'POST', headers: { Origin: 'https://attacker.invalid' } })
  assert.equal(denied.status, 403)
  assert.equal(denied.headers.get('cache-control'), 'private, no-store')
  assert.equal(denied.headers.get('x-frame-options'), 'DENY')
  assert.equal(denied.headers.get('access-control-allow-origin'), null)
  const allowed = await fetch('http://web/api/logout', { method: 'POST', headers: { Origin: process.env.PUBLIC_ORIGIN } })
  assert.equal(allowed.status, 200)
  assert.deepEqual(await request('/health'), { ok: true })
  assert.deepEqual(await request('/ready'), { ok: true })

  if (process.argv[2] === 'create') {
    await request('/login', { email: 'admin@example.invalid', password: 'isolated-container-password' })
    const image = await request('/images', { name: 'Synthetic fixture', mime: 'image/png', data: png }, 'POST', 201)
    const snapshot = { name: 'Container fixture', nodes: [{ id: 'sensor', position: { x: 10, y: 20 }, block: {
      name: 'Sensor', function: 'Measure', category: 'sensores', image: image.url,
      ports: [{ id: 'power', label: '3V3', protocol: 'POWER', direction: 'in' }],
    } }], edges: [] }
    const project = await request('/projects', { yaml: JSON.stringify(snapshot) }, 'POST', 201)
    snapshot.name = 'Container fixture updated'
    await request('/projects/' + project.id, { yaml: JSON.stringify(snapshot), expectedRevision: 1 }, 'PUT')
    const config = await request('/ai', { enabled: true, provider: 'deepseek', model: 'deepseek-flash', token: 'synthetic-provider-token' }, 'PUT')
    assert.equal(config.tokenConfigured, true)
    assert.equal(config.token, undefined)
    const analysis = await request(`/projects/${project.id}/analyses`, {
      snapshot, action: 'analyze', language: 'es', baseRevision: 2, requestId: crypto.randomUUID(),
    }, 'POST', 201)
    await request(`/projects/${project.id}/settings`, {
      visibility: 'private', sync_repository: 'synthetic/fixture', sync_branch: 'development', expectedSettingsVersion: 1,
    }, 'PATCH')
    // Legacy metadata has no writing capability. Exercise the scoped worker with
    // a synthetic encrypted account, own installation and an injected HTTP client.
    assert.equal((await q('SELECT status FROM sync_jobs WHERE record_id=$1', [project.id])).rows[0].status, 'blocked')
    const githubEnv = { PUBLIC_ORIGIN: 'https://sugar.example.invalid', GITHUB_CLIENT_ID: 'Iv1.synthetic', GITHUB_CLIENT_SECRET: 'synthetic-secret', GITHUB_USER_ENCRYPTION_KEY: '11'.repeat(32) }
    const token = 'ghu_' + 'a'.repeat(40)
    let writes = 0
    const client = createGithubClient({ request: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer ' + token)
      const path = new URL(url).pathname
      const result = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
      if (path === '/user/installations') return result({total_count:1,installations:[{id:7,account:{id:9,login:'synthetic'},permissions:{contents:'write'},suspended_at:null}]})
      if (path === '/user/installations/7/repositories') return result({total_count:1,repositories:[{id:8,owner:{id:9},full_name:'synthetic/fixture',private:true,default_branch:'development',permissions:{push:true},archived:false,disabled:false}]})
      if (path === '/repos/synthetic/fixture/branches/development') return result({name:'development'})
      assert.match(path, /\/contents\/projects\/[^/]+\/revision-2\.yaml$/)
      if (options.method !== 'PUT') return new Response(null, { status: 404 })
      writes++
      const body = JSON.parse(options.body)
      assert.equal(body.branch, 'development')
      assert.match(Buffer.from(body.content, 'base64').toString(), /Container fixture updated/)
      return result({ commit: { sha: 'a'.repeat(40) } })
    } })
    const github = createGithubIntegration({q,transaction,env:githubEnv,client})
    const owner = (await q("SELECT id,role,auth_version FROM users WHERE email='admin@example.invalid'")).rows[0], linkId = crypto.randomUUID()
    const accessBox = github.config.box.encrypt({userId:owner.id,linkId,purpose:'access'},token)
    await q('INSERT INTO github_links(user_id,id,client_id,auth_version,github_user_id,github_login,access_box) VALUES($1,$2,$3,$4,$5,$6,$7)', [owner.id,linkId,githubEnv.GITHUB_CLIENT_ID,owner.auth_version,'111','synthetic-user',accessBox])
    const sid = (await q('SELECT id FROM user_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[owner.id])).rows[0].id
    const grant = await github.targets.prepare({created_by:owner.id},owner,sid,{sync_installation_id:'7',sync_repository_id:'8'},'synthetic/fixture','development')
    await transaction(async tx => { await github.targets.save(tx,project.id,grant); await enqueue('project',project.id,2,JSON.stringify(snapshot),tx,{repository:'synthetic/fixture',branch:'development'}) })
    await syncOne({ integration: github })
    assert.equal(writes, 1)
    assert.equal((await q('SELECT status FROM sync_jobs WHERE record_id=$1 ORDER BY id DESC LIMIT 1', [project.id])).rows[0].status, 'synced')
    console.log(JSON.stringify({ project: project.id, image: image.id, analysis: analysis.id, cookie }))
  } else {
    assert.equal(process.argv[2], 'persist')
    const state = JSON.parse(fs.readFileSync(0, 'utf8'))
    cookie = state.cookie
    assert.equal((await request('/me')).role, 'Admin')
    assert.equal((await request('/projects/' + state.project)).revision, 2)
    assert.equal((await request(`/projects/${state.project}/revisions`)).length, 2)
    const response = await fetch(`http://web/api/images/${state.image}/content`, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(png, 'base64'))
    assert.equal((await request(`/projects/${state.project}/analyses/${state.analysis}`)).usage.total_tokens, 300)
    assert.equal((await request('/ai')).tokenConfigured, true)
    assert.equal((await request(`/projects/${state.project}/sync`))[0].status, 'synced')
    console.log('PASS: non-root/read-only API, no capabilities, private secrets, web/health, images, AI, sync and persistence after restart')
  }
} finally { await pool.end() }
