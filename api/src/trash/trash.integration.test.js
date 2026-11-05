import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { usageSql } from '../storage-total/migration.js'

// Explicit opt-in: disposable API + database only (same installation as the image/module suites).
const url = process.env.API_TEST_URL, databaseUrl = process.env.API_TEST_DATABASE_URL
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='

test('owners trash, restore and purge their own resources without affecting other accounts', { skip: !url || !databaseUrl }, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl }); t.after(() => pool.end())
  const sql = async (text, args) => (await pool.query(text, args)).rows
  const suffix = crypto.randomUUID().slice(0, 8), password = 'isolated-trash-password'
  async function req(path, cookie, method = 'GET', body) {
    const res = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') || ''
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: type.includes('application/json') ? await res.json() : null }
  }
  const admin = (await req('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const accounts = {}
  for (const name of ['a', 'b', 'view']) {
    const email = `trash-${name}-${suffix}@local`, r = await req('/users', admin, 'POST', { email, password, role: name === 'view' ? 'view' : 'dev' })
    assert.equal(r.status, 201)
    accounts[name] = { id: r.body.id, email, cookie: (await req('/login', null, 'POST', { email, password })).cookie }
  }
  const { a, b, view } = accounts
  const category = await req('/categories', a.cookie, 'POST', { name: 'Papelera ' + suffix, icon: 'cube' }); assert.equal(category.status, 201)
  const image = await req('/images', a.cookie, 'POST', { name: 'Trash pixel ' + suffix, mime: 'image/png', data: png }); assert.equal(image.status, 201)
  const block = { name: 'Bloque papelera ' + suffix, function: 'Probar', category: category.body.slug, image: image.body.url, ports: [{ id: 'p', label: 'P', protocol: 'IO', direction: 'in' }] }
  const blockId = (await req('/blocks', a.cookie, 'POST', { yaml: JSON.stringify(block) })).body.id
  const diagram = name => ({ name, nodes: [{ id: 'n', position: { x: 0, y: 0 }, block }], edges: [] })
  const projectName = 'Proyecto papelera ' + suffix
  const created = await req('/projects', a.cookie, 'POST', { yaml: JSON.stringify(diagram(projectName)) }); assert.equal(created.status, 201)
  const projectId = created.body.id, p = '/projects/' + projectId
  assert.equal((await req(p, a.cookie, 'PUT', { yaml: JSON.stringify(diagram(projectName)), expectedRevision: 1, summary: 'Segunda' })).status, 200)
  assert.equal((await req(p + '/members', a.cookie, 'PUT', { email: b.email, role: 'reader' })).status, 200)
  const share = await req(p + '/share', a.cookie, 'POST'); assert.equal(share.status, 200)
  const link = new URL('http://test' + share.body.path).searchParams.get('share')
  await sql("INSERT INTO sync_jobs(kind,record_id,revision,yaml,target_repository,target_branch) VALUES('project',$1,2,'name: x','test/repo','main')", [projectId])
  const counts = async () => (await sql(`SELECT (SELECT count(*) FROM project_revisions WHERE project_id=$1)::int AS revisions,
    (SELECT count(*) FROM project_members WHERE project_id=$1)::int AS members,
    (SELECT count(*) FROM project_settings_history WHERE project_id=$1)::int AS settings,
    (SELECT count(*) FROM image_references WHERE resource_id=$1)::int AS refs,
    (SELECT count(*) FROM sync_jobs WHERE record_id=$1)::int AS jobs`, [projectId]))[0]
  const listed = async cookie => (await req('/trash', cookie)).body.items.map(item => item.id)

  await t.test('trash hides the project from collaborators, links and lists but keeps history', async () => {
    assert.equal((await req(p, b.cookie)).status, 200)
    assert.equal((await req(p, b.cookie, 'DELETE')).status, 404) // collaborator is not the owner
    assert.equal((await req(p, view.cookie, 'DELETE')).status, 403)
    const before = await counts()
    assert.equal((await req(p, a.cookie, 'DELETE')).status, 200)
    assert.equal((await req(p, a.cookie, 'DELETE')).status, 404)
    for (const cookie of [a.cookie, b.cookie, admin]) assert.equal((await req(p, cookie)).status, 404)
    assert.equal((await req('/shared/' + link)).status, 404)
    assert.equal((await req('/projects', a.cookie)).body.some(item => item.id === projectId), false)
    assert.deepEqual(await counts(), before)
    // Trashed project jobs are skipped by the sync worker until restored.
    assert.equal((await sql(`SELECT count(*)::int AS n FROM sync_jobs j WHERE j.record_id=$1 AND j.status='pending'
      AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=j.record_id AND p.deleted_at IS NOT NULL)`, [projectId]))[0].n, 0)
  })
  await t.test('only the owner and Admin see the trash; listing pages are stable', async () => {
    assert.equal((await req(`/blocks/${blockId}`, a.cookie, 'DELETE')).status, 200)
    const own = (await req('/trash', a.cookie)).body.items
    assert.deepEqual(own.map(item => item.id).slice(0, 2), [blockId, projectId])
    assert.equal(own[0].kind, 'block'); assert.equal(own[0].purgeable, false); assert.equal(own[0].retentionDays, 30); assert.ok(own[0].purge_after)
    assert.equal((await listed(b.cookie)).includes(projectId), false)
    assert.equal((await req('/trash', view.cookie)).status, 403)
    const adminItems = (await req('/trash?limit=100', admin)).body.items
    assert.equal(adminItems.find(item => item.id === projectId)?.owner, a.email)
    const first = (await req('/trash?limit=1', a.cookie)).body
    assert.deepEqual(first.items.map(item => item.id), [blockId])
    const second = (await req('/trash?limit=1&cursor=' + first.nextCursor, a.cookie)).body
    assert.deepEqual(second.items.map(item => item.id), [projectId])
    assert.equal((await req('/trash?kind=project', a.cookie)).status, 400)
  })
  await t.test('restore brings back access without reviving the private link', async () => {
    assert.equal((await req(`/trash/project/${projectId}/restore`, b.cookie, 'POST')).status, 404)
    assert.equal((await req(`/trash/project/${projectId}/restore`, a.cookie, 'POST')).status, 200)
    assert.equal((await req(`/trash/project/${projectId}/restore`, a.cookie, 'POST')).status, 409)
    assert.equal((await req(p, b.cookie)).status, 200)
    assert.equal((await req('/shared/' + link)).status, 404)
    assert.equal((await req(`/trash/block/${blockId}/restore`, admin, 'POST')).status, 200)
    assert.equal((await req('/blocks/' + blockId, a.cookie)).status, 200)
  })
  await t.test('purge waits 30 days, needs the exact name, frees retained rows and keeps counters exact', async () => {
    assert.equal((await req(p, a.cookie, 'DELETE')).status, 200)
    const purge = (cookie, confirm) => req(`/trash/project/${projectId}`, cookie, 'DELETE', { confirm })
    const early = await purge(a.cookie, projectName)
    assert.equal(early.status, 409); assert.match(early.body.error, /30/)
    await sql("UPDATE projects SET deleted_at=now()-interval '31 days' WHERE id=$1", [projectId])
    assert.equal((await purge(b.cookie, projectName)).status, 404)
    assert.equal((await purge(a.cookie, projectName.toUpperCase())).status, 400)
    // Retained bytes of this project only: other suites write to the same database concurrently.
    const projectBytes = async () => BigInt((await sql(`SELECT COALESCE((SELECT octet_length(yaml)::bigint+octet_length(name) FROM projects WHERE id=$1),0)
      +(SELECT COALESCE(sum(octet_length(yaml)::bigint+octet_length(summary)),0) FROM project_revisions WHERE project_id=$1)
      +(SELECT COALESCE(sum(octet_length(before::text)::bigint+octet_length(after::text)),0) FROM project_settings_history WHERE project_id=$1) AS bytes`, [projectId]))[0].bytes)
    assert.ok(await projectBytes() > 0n)
    assert.equal((await purge(a.cookie, projectName)).status, 200)
    assert.deepEqual(await counts(), { revisions: 0, members: 0, settings: 0, refs: 0, jobs: 0 })
    assert.equal((await sql('SELECT count(*)::int AS n FROM projects WHERE id=$1', [projectId]))[0].n, 0)
    assert.equal(await projectBytes(), 0n)
    // One statement, one snapshot: each writer commits its counter delta atomically with its rows.
    const [row] = await sql(`SELECT row_to_json(u.*)::jsonb - 'id' AS stored, row_to_json(m.*)::jsonb AS measured FROM total_storage_usage u, (${usageSql}) m`)
    for (const field of Object.keys(row.stored)) assert.equal(String(row.stored[field]), String(row.measured[field]), field)
    // Other accounts' resources are untouched.
    assert.equal((await req('/blocks/' + blockId, a.cookie)).status, 200)
    assert.equal((await req(image.body.url.replace(/^\/api/, ''), a.cookie)).status, 200)
  })
  await t.test('a concurrent restore and purge never both succeed', async () => {
    assert.equal((await req(`/blocks/${blockId}`, a.cookie, 'DELETE')).status, 200)
    await sql("UPDATE blocks SET deleted_at=now()-interval '31 days' WHERE id=$1", [blockId])
    const [restore, purge] = await Promise.all([
      req(`/trash/block/${blockId}/restore`, a.cookie, 'POST'),
      req(`/trash/block/${blockId}`, a.cookie, 'DELETE', { confirm: block.name }),
    ])
    assert.equal([restore.status, purge.status].filter(status => status === 200).length, 1, `${restore.status} ${purge.status}`)
    const exists = (await sql('SELECT count(*)::int AS n FROM blocks WHERE id=$1', [blockId]))[0].n
    assert.equal(exists, restore.status === 200 ? 1 : 0)
    if (!exists) assert.equal((await sql('SELECT count(*)::int AS n FROM block_versions WHERE block_id=$1', [blockId]))[0].n, 0)
  })
})
