import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

// Explicit opt-in: disposable API installation only.
const url = process.env.API_TEST_URL

test('latest block versions are reported only for blocks the caller can read', { skip: !url }, async () => {
  const suffix = crypto.randomUUID().slice(0, 8), password = 'isolated-versions-password'
  async function req(path, cookie, method = 'GET', body) {
    const res = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: await res.json().catch(() => null) }
  }
  const admin = (await req('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const cookies = {}
  for (const name of ['owner', 'other']) {
    const email = `versions-${name}-${suffix}@local`
    assert.equal((await req('/users', admin, 'POST', { email, password, role: 'dev' })).status, 201)
    cookies[name] = (await req('/login', null, 'POST', { email, password })).cookie
  }
  const category = (await req('/categories', cookies.owner, 'POST', { name: 'Versiones ' + suffix, icon: 'cube' })).body
  const block = { name: 'Versión ' + suffix, function: 'Probar', category: category.slug, ports: [{ id: 'p', label: 'P', protocol: 'IO', direction: 'in' }] }
  const personal = (await req('/blocks', cookies.owner, 'POST', { yaml: JSON.stringify(block) })).body.id
  const shared = (await req('/categories', admin, 'POST', { name: 'Catálogo versiones ' + suffix, icon: 'cube', scope: 'catalog' })).body
  const catalogResult = await req('/blocks', admin, 'POST', { yaml: JSON.stringify({ ...block, name: 'Catálogo ' + suffix, category: shared.slug }), scope: 'catalog' })
  assert.equal(catalogResult.status, 201)
  const catalog = catalogResult.body.id, ids = [personal, catalog]
  const versions = async cookie => (await req('/blocks/latest-versions', cookie, 'POST', { ids })).body.versions
  assert.equal((await versions(cookies.owner))[personal], 1)
  assert.equal(personal in (await versions(cookies.other)), false)
  assert.equal((await versions(cookies.other))[catalog], 1)
  assert.equal((await req('/blocks/' + personal, cookies.owner, 'PUT', { yaml: JSON.stringify({ ...block, function: 'Medir' }), expectedVersion: 1 })).status, 200)
  assert.equal((await versions(cookies.owner))[personal], 2)
  assert.equal((await req('/blocks/' + personal, cookies.owner, 'DELETE')).status, 200)
  assert.equal(personal in (await versions(cookies.owner)), false)
  assert.equal((await req('/blocks/latest-versions', null, 'POST', { ids })).status, 401)
  assert.equal((await req('/blocks/latest-versions', cookies.owner, 'POST', { ids: ['nope'] })).status, 400)
})
