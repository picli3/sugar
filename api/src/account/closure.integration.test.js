import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'

// Explicit opt-in: disposable API + database only.
const url = process.env.API_TEST_URL, databaseUrl = process.env.API_TEST_DATABASE_URL
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='

test('closing an account revokes access and trashes its resources; Admin reopens within 30 days', { skip: !url || !databaseUrl }, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl }); t.after(() => pool.end())
  const sql = async (text, args) => (await pool.query(text, args)).rows
  const suffix = crypto.randomUUID().slice(0, 8), password = 'isolated-closure-password'
  async function req(path, cookie, method = 'GET', body) {
    const res = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') || ''
    return { status: res.status, setCookie: res.headers.get('set-cookie') || '', cookie: res.headers.get('set-cookie')?.split(';')[0], body: type.includes('json') ? await res.json() : null }
  }
  const login = async email => req('/login', null, 'POST', { email, password })
  const admin = (await req('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const accounts = {}
  for (const name of ['leaver', 'peer']) {
    const email = `closure-${name}-${suffix}@local`
    const created = await req('/users', admin, 'POST', { email, password, role: 'dev' }); assert.equal(created.status, 201)
    accounts[name] = { id: created.body.id, email, cookie: (await login(email)).cookie }
  }
  const { leaver, peer } = accounts
  const projectId = (await req('/projects', leaver.cookie, 'POST', { name: 'Cierre ' + suffix })).body.id
  assert.equal((await req(`/projects/${projectId}/members`, leaver.cookie, 'PUT', { email: peer.email, role: 'reader' })).status, 200)
  const link = new URL('http://test' + (await req(`/projects/${projectId}/share`, leaver.cookie, 'POST')).body.path).searchParams.get('share')
  const image = (await req('/images', leaver.cookie, 'POST', { name: 'Closure pixel', mime: 'image/png', data: png })).body
  const earlier = (await req('/images', leaver.cookie, 'POST', { name: 'Trashed earlier', mime: 'image/png', data: png })).body
  assert.equal((await req('/images/' + earlier.id, leaver.cookie, 'DELETE')).status, 200)
  const peerProject = (await req('/projects', peer.cookie, 'POST', { name: 'Peer ' + suffix })).body.id

  await t.test('closure needs the password and typed email, then revokes sessions and trashes owned resources', async () => {
    assert.equal((await req('/me/close', leaver.cookie, 'POST', { currentPassword: password, confirm: 'someone@else' })).status, 400)
    assert.equal((await req('/me/close', leaver.cookie, 'POST', { currentPassword: 'wrong-password-123', confirm: leaver.email })).status, 400)
    assert.equal((await req(`/projects/${projectId}`, peer.cookie)).status, 200)
    const closed = await req('/me/close', leaver.cookie, 'POST', { currentPassword: password, confirm: leaver.email })
    assert.equal(closed.status, 200); assert.equal(closed.body.closed, true); assert.match(closed.setCookie, /session=;/)
    assert.equal((await req('/me', leaver.cookie)).status, 401)
    assert.equal((await login(leaver.email)).status, 401)
    assert.equal((await req(`/projects/${projectId}`, peer.cookie)).status, 404)
    assert.equal((await req('/shared/' + link)).status, 404)
    const [row] = await sql(`SELECT u.closed_at,(SELECT deleted_at FROM projects WHERE id=$2) AS project,(SELECT deleted_at FROM images WHERE id=$3) AS image,
      (SELECT count(*)::int FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL) AS sessions FROM users u WHERE u.id=$1`, [leaver.id, projectId, image.id])
    assert.ok(row.closed_at); assert.equal(+row.project, +row.closed_at); assert.equal(+row.image, +row.closed_at); assert.equal(row.sessions, 0)
    // Other accounts' resources are untouched.
    assert.equal((await req(`/projects/${peerProject}`, peer.cookie)).status, 200)
    const listed = (await req('/users', admin)).body.find(user => user.id === leaver.id)
    assert.ok(listed.closed_at); assert.equal(listed.active, false)
  })
  await t.test('only Admin reopens; exactly the closure-trashed resources come back', async () => {
    assert.equal((await req(`/users/${leaver.id}/reopen`, peer.cookie, 'POST')).status, 403)
    const reopened = await req(`/users/${leaver.id}/reopen`, admin, 'POST')
    assert.equal(reopened.status, 200); assert.deepEqual(reopened.body.restored, { projects: 1, blocks: 0, images: 1 })
    assert.equal((await req(`/users/${leaver.id}/reopen`, admin, 'POST')).status, 409)
    const session = (await login(leaver.email)).cookie
    assert.ok(session)
    assert.equal((await req(`/projects/${projectId}`, peer.cookie)).status, 200)
    assert.equal((await req('/shared/' + link)).status, 404)
    assert.ok((await sql('SELECT deleted_at FROM images WHERE id=$1', [earlier.id]))[0].deleted_at, 'items trashed before closure stay in the trash')
    leaver.cookie = session
  })
  await t.test('reopening is refused after the 30-day window', async () => {
    assert.equal((await req('/me/close', leaver.cookie, 'POST', { currentPassword: password, confirm: leaver.email })).status, 200)
    await sql("UPDATE users SET closed_at=closed_at-interval '31 days' WHERE id=$1", [leaver.id])
    const late = await req(`/users/${leaver.id}/reopen`, admin, 'POST')
    assert.equal(late.status, 409); assert.match(late.body.error, /30/)
    assert.equal((await login(leaver.email)).status, 401)
  })
})
