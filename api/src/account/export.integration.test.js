import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readZip } from '../../test-support/zip.js'

// Explicit opt-in: disposable API installation only.
const url = process.env.API_TEST_URL
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='

test('account export contains only the requester data, full history and no secrets', { skip: !url }, async () => {
  const suffix = crypto.randomUUID().slice(0, 8), password = 'isolated-export-password'
  async function req(path, cookie, method = 'GET', body) {
    const res = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') || ''
    return { status: res.status, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0], body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) }
  }
  const admin = (await req('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const accounts = {}
  for (const name of ['owner', 'helper']) {
    const email = `export-${name}-${suffix}@local`
    assert.equal((await req('/users', admin, 'POST', { email, password, role: 'dev' })).status, 201)
    accounts[name] = { email, cookie: (await req('/login', null, 'POST', { email, password })).cookie }
  }
  const { owner, helper } = accounts
  await req('/me', helper.cookie, 'PATCH', { displayName: 'Colaboradora' })
  const category = (await req('/categories', owner.cookie, 'POST', { name: 'Export ' + suffix, icon: 'cube' })).body
  const image = (await req('/images', owner.cookie, 'POST', { name: 'Export pixel', mime: 'image/png', data: png })).body
  const block = { name: 'Bloque export ' + suffix, function: 'Probar', category: category.slug, ports: [{ id: 'p', label: 'P', protocol: 'IO', direction: 'in' }] }
  const blockId = (await req('/blocks', owner.cookie, 'POST', { yaml: JSON.stringify(block) })).body.id
  assert.equal((await req('/blocks/' + blockId, owner.cookie, 'PUT', { yaml: JSON.stringify({ ...block, function: 'Medir' }), expectedVersion: 1 })).status, 200)
  const projectId = (await req('/projects', owner.cookie, 'POST', { name: 'Export ' + suffix })).body.id
  assert.equal((await req(`/projects/${projectId}/members`, owner.cookie, 'PUT', { email: helper.email, role: 'editor' })).status, 200)
  assert.equal((await req('/projects/' + projectId, helper.cookie, 'PUT', { yaml: JSON.stringify({ name: 'Export ' + suffix, nodes: [], edges: [] }), expectedRevision: 1, summary: 'Cambio de colaboradora' })).status, 200)
  assert.equal((await req(`/projects/${projectId}/share`, owner.cookie, 'POST')).status, 200)
  const foreignId = (await req('/projects', helper.cookie, 'POST', { name: 'Ajeno ' + suffix })).body.id
  assert.equal((await req(`/projects/${foreignId}/members`, helper.cookie, 'PUT', { email: owner.email, role: 'reader' })).status, 200)
  assert.equal((await req(`/projects/${foreignId}/favorite`, owner.cookie, 'PUT', { favorite: true })).status, 200)
  assert.equal((await req(`/projects/${projectId}/favorite`, helper.cookie, 'PUT', { favorite: true })).status, 200)
  const trashed = (await req('/images', owner.cookie, 'POST', { name: 'Trashed pixel', mime: 'image/png', data: png })).body
  assert.equal((await req('/images/' + trashed.id, owner.cookie, 'DELETE')).status, 200)

  assert.equal((await req('/me/export')).status, 401)
  const result = await req('/me/export', owner.cookie)
  assert.equal(result.status, 200)
  assert.match(result.headers.get('content-type'), /application\/zip/)
  assert.match(result.headers.get('content-disposition'), /attachment; filename="sugar-export-\d{4}-\d{2}-\d{2}\.zip"/)
  assert.match(result.headers.get('cache-control'), /no-store/)
  const entries = readZip(result.body), names = [...entries.keys()], text = name => entries.get(name).toString()
  const all = names.map(name => name.endsWith('.png') ? '' : text(name)).join('\n')
  for (const name of ['README.txt', 'account.json', 'collaborations.json', 'categories.json', 'images/images.json',
    `projects/${projectId}/current.yaml`, `projects/${projectId}/revisions/1.yaml`, `projects/${projectId}/revisions/2.yaml`, `projects/${projectId}/members.json`,
    `blocks/${blockId}/versions/1.yaml`, `blocks/${blockId}/versions/2.yaml`, `images/${image.id}.png`, `images/${trashed.id}.png`]) assert.ok(names.includes(name), name)
  assert.equal(JSON.parse(text('account.json')).account.email, owner.email)
  assert.equal(names.some(name => name.includes(foreignId)), false)
  assert.deepEqual(JSON.parse(text('collaborations.json')).map(item => item.project_id), [foreignId])
  assert.deepEqual(JSON.parse(text('project-favorites.json')), [{ project_id: foreignId }])
  assert.equal(JSON.parse(text(`projects/${projectId}/revisions.json`))[1].author, 'Colaboradora')
  assert.equal(JSON.parse(text('images/images.json')).find(item => item.id === trashed.id).trashed_at !== null, true)
  assert.deepEqual(entries.get(`images/${image.id}.png`).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  // Secrets and other accounts' private data stay out; invited collaborators are listed for the owner.
  for (const secret of ['password_hash', '$2a$', '$2b$', 'share_token', 'auth_version']) assert.equal(all.includes(secret), false, secret)
  assert.equal(text(`projects/${projectId}/members.json`).includes(helper.email), true)
  assert.equal(all.replace(text(`projects/${projectId}/members.json`), '').includes(helper.email), false)
  // The durable security log holds only the requester's own events (#23).
  const log = JSON.parse(text('security-log.json'))
  assert.ok(log.some(event => event.operation === 'project.share_create' && event.resource === projectId && event.result === 'success'))
  assert.equal(log.some(event => event.operation === 'project.members_update' && event.resource === foreignId), false)
  assert.equal(JSON.stringify(log).includes('actor'), false)
  // Another account cannot obtain this data.
  const other = readZip((await req('/me/export', helper.cookie)).body)
  assert.equal([...other.keys()].some(name => name.includes(projectId) || name.includes(blockId)), false)
})
