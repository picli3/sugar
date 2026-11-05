import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// Explicit opt-in: disposable API installation only.
const url = process.env.API_TEST_URL
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='

test('people are shown to others by public name; private emails reach only themselves and Admin', { skip: !url }, async t => {
  const suffix = crypto.randomUUID().slice(0, 8), password = 'isolated-identity-password'
  async function req(path, cookie, method = 'GET', body) {
    const res = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') || ''
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: type.includes('application/json') ? await res.json() : await res.text() }
  }
  const admin = (await req('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const accounts = {}
  for (const name of ['owner', 'reader']) {
    const email = `identity-${name}-${suffix}@local`
    assert.equal((await req('/users', admin, 'POST', { email, password, role: 'dev' })).status, 201)
    accounts[name] = { email, cookie: (await req('/login', null, 'POST', { email, password })).cookie }
  }
  const { owner, reader } = accounts
  const leaks = (value, email) => JSON.stringify(value).includes(email)

  await t.test('public names are validated, saved and returned only to their owner session', async () => {
    assert.equal((await req('/me', owner.cookie)).body.display_name, null)
    for (const displayName of ['a'.repeat(61), 'Ana‮Ruiz', 7]) assert.equal((await req('/me', owner.cookie, 'PATCH', { displayName })).status, 400)
    const saved = await req('/me', owner.cookie, 'PATCH', { displayName: '  Ana   Diseño ' })
    assert.equal(saved.status, 200); assert.equal(saved.body.display_name, 'Ana Diseño')
    assert.equal((await req('/me', owner.cookie, 'PATCH', { theme: 'dark' })).body.display_name, 'Ana Diseño')
    assert.equal((await req('/me', owner.cookie)).body.display_name, 'Ana Diseño')
  })
  let projectId
  await t.test('public, shared and collaborator views use the public name, never the email', async () => {
    const created = await req('/projects', owner.cookie, 'POST', { name: 'Identidad ' + suffix }); assert.equal(created.status, 201)
    projectId = created.body.id
    assert.equal((await req(`/projects/${projectId}/members`, owner.cookie, 'PUT', { email: reader.email, role: 'reader' })).status, 200)
    assert.equal((await req(`/projects/${projectId}/settings`, owner.cookie, 'PATCH', { visibility: 'public', expectedSettingsVersion: 1 })).status, 200)
    const views = [
      await req('/public/projects/' + projectId),
      await req('/projects/' + projectId, reader.cookie),
      await req(`/projects/${projectId}/revisions`, reader.cookie),
      await req(`/projects/${projectId}/revisions/page`, reader.cookie),
      await req(`/projects/${projectId}/settings/history/page`, reader.cookie),
      await req('/projects/page', reader.cookie),
    ]
    for (const view of views) { assert.equal(view.status, 200); assert.equal(leaks(view.body, owner.email), false) }
    assert.equal(views[0].body.creator, 'Ana Diseño'); assert.equal(views[1].body.creator, 'Ana Diseño')
    assert.equal(views[2].body[0].author, 'Ana Diseño')
    // Clearing the name hides identity from others instead of falling back to the email.
    assert.equal((await req('/me', owner.cookie, 'PATCH', { displayName: '' })).body.display_name, null)
    const anonymous = await req('/public/projects/' + projectId)
    assert.equal(anonymous.body.creator, null); assert.equal(leaks(anonymous.body, owner.email), false)
    assert.equal((await req('/projects/' + projectId, owner.cookie)).body.creator, owner.email)
    assert.equal((await req('/projects/' + projectId, admin)).body.creator, owner.email)
  })
  await t.test('catalog uploads do not reveal the uploader email to other accounts', async () => {
    const image = await req('/images', admin, 'POST', { name: 'Identity ' + suffix, mime: 'image/png', data: png, scope: 'catalog' }); assert.equal(image.status, 201)
    const page = await req('/images/page', reader.cookie)
    const item = page.body.items.find(entry => entry.id === image.body.id)
    assert.ok(item); assert.equal(item.creator, null); assert.equal(leaks(page.body, 'admin@local'), false)
    assert.equal((await req('/images/page', admin)).body.items.find(entry => entry.id === image.body.id).creator, 'admin@local')
  })
})
