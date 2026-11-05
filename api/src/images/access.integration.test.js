import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { migrateImageAccess } from './migration.js'
import { createImageRepository } from './repository.js'
import { createImageService } from './service.js'
import { createProjectRepository } from '../projects/repository.js'
import { createProjectService } from '../projects/service.js'
const url = process.env.API_TEST_URL, databaseUrl = process.env.API_TEST_DATABASE_URL
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='
const block = image => ({ name: 'Image block', function: 'Test permissions', category: 'sensores', image, ports: [{ id: 'p', label: 'P', protocol: 'POWER', direction: 'in' }] })
const diagram = image => ({ name: 'Image project', nodes: image ? [{ id: 'n', position: { x: 0, y: 0 }, block: block(image) }] : [], edges: [] })

test('image access follows ownership, resource membership, publication and expiring shares', { skip: !url || !databaseUrl }, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl }); t.after(() => pool.end())
  const suffix = crypto.randomUUID().slice(0, 8), password = 'isolated-image-password'
  async function req(path, cookie, method = 'GET', body, headers = {}) {
    const res = await fetch(url + (path.startsWith('/api/') ? path : '/api' + path), { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
    const type = res.headers.get('content-type') || ''
    return { status: res.status, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0], body: type.includes('application/json') ? await res.json() : type.startsWith('image/') ? Buffer.from(await res.arrayBuffer()) : await res.text() }
  }
  const admin = (await req('/login', null, 'POST', { email: 'admin@local', password: 'local-icons-verification-password' })).cookie
  const accounts = []
  for (const name of ['a', 'b', 'view']) {
    const email = `image-${name}-${suffix}@local`, r = await req('/users', admin, 'POST', { email, password, role: name === 'view' ? 'view' : 'dev' })
    assert.equal(r.status, 201)
    accounts.push({ id: r.body.id, email, cookie: (await req('/login', null, 'POST', { email, password })).cookie })
  }
  const [a, b, viewer] = accounts
  const upload = async (cookie, scope = 'personal') => { const r = await req('/images', cookie, 'POST', { name: 'Pixel ' + suffix, mime: 'image/png', data: png, scope, owner_id: b.id }); assert.equal(r.status, 201); return r.body }
  const own = await upload(a.cookie), other = await upload(b.cookie), catalog = await upload(admin, 'catalog')
  const path = own.url
  await t.test('private bytes and gallery entries cannot be enumerated or claimed by another account', async () => {
    assert.equal(own.owner_id, a.id)
    for (const cookie of [null, b.cookie, viewer.cookie, 'session=invalid']) assert.equal((await req(path, cookie)).status, 404)
    assert.equal((await req(path, a.cookie)).status, 200)
    assert.deepEqual((await req(path, a.cookie)).body, Buffer.from(png, 'base64'))
    const list = (await req('/images', b.cookie)).body
    assert.equal(list.some(i => i.id === own.id), false); assert.equal(list.some(i => i.id === catalog.id), true)
    assert.equal((await req(catalog.url)).status, 404); assert.equal((await req(catalog.url, viewer.cookie)).status, 200)
    assert.equal((await req('/images', b.cookie, 'POST', { name: 'Forbidden', mime: 'image/png', data: png, scope: 'catalog' })).status, 403)
    assert.equal((await req('/images', viewer.cookie, 'POST', { name: 'Forbidden', mime: 'image/png', data: png })).status, 403)
    for (const [kind, yaml] of [['projects', diagram(path)], ['blocks', block(path)]]) assert.equal((await req('/' + kind, b.cookie, 'POST', { yaml: JSON.stringify(yaml) })).status, 404)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_references WHERE image_id=$1', [own.id])).rows[0].n, 0)
  })
  await t.test('failed history writes roll back image grants with the resource transaction', async () => {
    const q = (sql, args) => pool.query(sql, args), repo = createProjectRepository(q)
    const service = createProjectService({ projects: { ...repo, addRevision: async (...args) => { await repo.addRevision(...args); throw Error('Injected history failure') } }, transaction: createTransaction(pool), attachImages: createImageService(createImageRepository(q)).attach })
    await assert.rejects(service.create({ id: a.id, role: 'dev' }, { yaml: JSON.stringify(diagram(path)) }), /Injected history failure/)
    assert.equal((await q('SELECT count(*)::int AS n FROM image_references WHERE image_id=$1', [own.id])).rows[0].n, 0)
  })
  const project = (await req('/projects', a.cookie, 'POST', { yaml: JSON.stringify(diagram(path)) })).body
  assert.ok(project.id)
  const p = '/projects/' + project.id
  await t.test('readers gain resource access without enumerating the uploader gallery; removal revokes it', async () => {
    assert.equal((await req(p + '/members', a.cookie, 'PUT', { email: b.email, role: 'reader' })).status, 200)
    assert.equal((await req(path, b.cookie)).status, 200)
    assert.equal((await req('/images', b.cookie)).body.some(i => i.id === own.id), false)
    assert.equal((await req(p + '/members/' + b.id, a.cookie, 'DELETE')).status, 200)
    assert.equal((await req(path, b.cookie)).status, 404)
  })
  let token
  await t.test('share grants only current image bytes from its own project and never other assets', async () => {
    const shared = await req(p + '/share', a.cookie, 'POST')
    assert.equal(shared.status, 200); assert.ok(new Date(shared.body.expiresAt) > new Date())
    token = new URL('http://test' + shared.body.path).searchParams.get('share')
    const sharedPath = `/shared/${token}/images/${own.id}/content`
    assert.equal((await req(path)).status, 404)
    const r = await req(sharedPath)
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.equal(r.headers.get('etag'), null)
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await req(sharedPath, null, 'GET', null, { 'if-none-match': '*', 'if-modified-since': new Date().toUTCString() })).status, 200)
    assert.equal((await req(`/shared/${token}/images/${other.id}/content`)).status, 404)
    assert.equal((await req('/shared/' + token)).headers.get('cache-control'), 'private, no-store')
    assert.equal((await req(p + '/share', a.cookie, 'DELETE')).status, 200)
    assert.equal((await req(sharedPath)).status, 404); assert.equal((await req('/shared/' + token)).status, 404)
    const renewed = await req(p + '/share', a.cookie, 'POST'); token = new URL('http://test' + renewed.body.path).searchParams.get('share')
    await pool.query("UPDATE projects SET share_expires_at=now()-interval '1 second' WHERE id=$1", [project.id])
    assert.equal((await req(`/shared/${token}/images/${own.id}/content`)).status, 404); assert.equal((await req('/shared/' + token)).status, 404)
    const fresh = await req(p + '/share', a.cookie, 'POST'); assert.notEqual(new URL('http://test' + fresh.body.path).searchParams.get('share'), token)
  })
  await t.test('publication grants only current images; making private removes anonymous access immediately', async () => {
    assert.equal((await req(p + '/settings', a.cookie, 'PATCH', { visibility: 'public', expectedSettingsVersion: 1 })).status, 200)
    assert.equal((await req(path)).status, 200)
    assert.equal((await req(p, a.cookie, 'PUT', { yaml: JSON.stringify(diagram(null)), expectedRevision: 1 })).status, 200)
    assert.equal((await req(path)).status, 404)
    // Authenticated public-project history remains readable, as do its images.
    assert.equal((await req(path, b.cookie)).status, 200)
    assert.equal((await req(p + '/settings', a.cookie, 'PATCH', { visibility: 'private', expectedSettingsVersion: 2 })).status, 200)
    assert.equal((await req(path, b.cookie)).status, 404)
    assert.equal((await req(p + '/restore', a.cookie, 'POST', { revision: 1, expectedRevision: 2 })).status, 200)
    assert.equal((await req(path)).status, 404)
  })
  await t.test('authorized independent reuse survives revoking the original grant', async () => {
    await req(p + '/members', a.cookie, 'PUT', { email: b.email, role: 'reader' })
    const copy = await req('/projects', b.cookie, 'POST', { yaml: JSON.stringify(diagram(path)) }); assert.equal(copy.status, 201)
    await req(p + '/members/' + b.id, a.cookie, 'DELETE')
    assert.equal((await req(path, b.cookie)).status, 200)
    assert.equal((await req(path, viewer.cookie)).status, 404)
    // Removing all readable resources removes the grant, including cached/conditional requests.
    await req('/projects/' + copy.body.id, admin, 'DELETE')
    assert.equal((await req(path, b.cookie, 'GET', null, { 'if-none-match': '*' })).status, 404)
  })
  await t.test('catalog block reuse grants content, not the private library or unrelated images', async () => {
    const created = await req('/blocks', admin, 'POST', { yaml: JSON.stringify(block(path)), scope: 'catalog' }); assert.equal(created.status, 201)
    assert.equal((await req(path, viewer.cookie)).status, 200); assert.equal((await req(path)).status, 404)
    assert.equal((await req(other.url, viewer.cookie)).status, 404)
    await req('/blocks/' + created.body.id, admin, 'DELETE')
    assert.equal((await req(path, viewer.cookie)).status, 404)
    const old = await req(p + '/share', a.cookie, 'POST'), link = new URL('http://test' + old.body.path).searchParams.get('share')
    // Trash keeps existing references working (#19); only an explicit purge cuts them.
    const access = async () => [...await Promise.all([a.cookie, admin, null].map(async cookie => (await req(path, cookie)).status)), (await req(`/shared/${link}/images/${own.id}/content`)).status]
    const before = await access()
    assert.equal((await req('/images/' + own.id, b.cookie, 'DELETE')).status, 404)
    assert.equal((await req('/images/' + own.id, a.cookie, 'DELETE')).status, 200)
    assert.deepEqual(await access(), before)
    assert.equal((await req('/images', a.cookie)).body.some(i => i.id === own.id), false)
    // The owner cannot attach a trashed image to a new resource.
    assert.equal((await req('/projects', a.cookie, 'POST', { yaml: JSON.stringify(diagram(path)) })).status, 404)
    const purge = (cookie, confirm) => req('/trash/image/' + own.id, cookie, 'DELETE', { confirm })
    assert.equal((await purge(a.cookie, own.name)).status, 409)
    await pool.query("UPDATE images SET deleted_at=now()-interval '31 days' WHERE id=$1", [own.id])
    assert.equal((await purge(b.cookie, own.name)).status, 404)
    assert.equal((await purge(a.cookie, 'wrong')).status, 400)
    assert.equal((await purge(a.cookie, own.name)).status, 200)
    for (const cookie of [a.cookie, admin, null]) assert.equal((await req(path, cookie)).status, 404)
    assert.equal((await req(`/shared/${link}/images/${own.id}/content`)).status, 404)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM image_references WHERE image_id=$1', [own.id])).rows[0].n, 0)
    // Documents that still mention the purged image remain editable.
    assert.equal((await req('/projects', a.cookie, 'POST', { yaml: JSON.stringify(diagram(path)) })).status, 201)
  })
})

test('image migration preserves legacy bytes, ownership, historical grants and canonical URLs', { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl }), client = await pool.connect()
  const schema = 'image_migration_' + crypto.randomUUID().replaceAll('-', '')
  const query = (sql, args) => client.query(sql, args)
  const transaction = createTransaction({ connect: async () => ({ query, release() {} }) })
  try {
    await query(`CREATE SCHEMA ${schema}`); await query(`SET search_path TO ${schema}`)
    await query('CREATE TABLE users(id uuid PRIMARY KEY,display_name text)')
    await query('CREATE TABLE images(id uuid PRIMARY KEY,name text,mime text,data bytea,created_by uuid REFERENCES users(id),deleted_at timestamptz)')
    await query('CREATE TABLE projects(id uuid PRIMARY KEY,revision integer,share_token text)')
    await query('CREATE TABLE blocks(id uuid PRIMARY KEY,latest_version integer)')
    await query('CREATE TABLE project_revisions(project_id uuid,revision integer,yaml text)')
    await query('CREATE TABLE block_versions(block_id uuid,version integer,yaml text)')
    await query('CREATE TABLE settings(key text PRIMARY KEY,value jsonb)')
    const owner = crypto.randomUUID(), imageId = crypto.randomUUID(), oldId = crypto.randomUUID(), p = crypto.randomUUID(), b = crypto.randomUUID()
    await query('INSERT INTO users VALUES($1)', [owner])
    for (const id of [imageId, oldId]) await query("INSERT INTO images VALUES($1,'Legacy','image/png',$2,$3,NULL)", [id, Buffer.from(png, 'base64'), owner])
    const imagePath = `/api/images/${imageId}/content`, oldPath = `/api/images/${oldId}/content`
    const projectYaml = JSON.stringify(diagram(imagePath)), blockYaml = JSON.stringify(block(imagePath))
    await query("INSERT INTO projects VALUES($1,2,$2)", [p, 'a'.repeat(43)])
    await query('INSERT INTO project_revisions VALUES($1,1,$2),($1,2,$3)', [p, JSON.stringify(diagram(oldPath)), projectYaml])
    await query('INSERT INTO blocks VALUES($1,1)', [b]); await query('INSERT INTO block_versions VALUES($1,1,$2)', [b, blockYaml])
    await migrateImageAccess(transaction)
    const migrated = (await query('SELECT * FROM images WHERE id=$1', [imageId])).rows[0]
    assert.equal(migrated.owner_id, owner); assert.equal(migrated.scope, 'personal'); assert.deepEqual(migrated.data, Buffer.from(png, 'base64'))
    const refs = (await query('SELECT image_id,current FROM image_references WHERE resource_id=$1 ORDER BY current', [p])).rows
    assert.deepEqual(refs, [{ image_id: oldId, current: false }, { image_id: imageId, current: true }])
    assert.equal((await query('SELECT yaml FROM project_revisions WHERE revision=2')).rows[0].yaml, projectYaml)
    assert.equal((await query('SELECT yaml FROM block_versions')).rows[0].yaml, blockYaml)
    assert.ok((await query('SELECT share_expires_at>now() AS valid FROM projects')).rows[0].valid)
    await query("UPDATE images SET scope='catalog',owner_id=NULL WHERE id=$1", [imageId])
    await migrateImageAccess(transaction)
    assert.equal((await query('SELECT owner_id FROM images WHERE id=$1', [imageId])).rows[0].owner_id, null)
    assert.equal((await query('SELECT count(*)::int AS n FROM image_references')).rows[0].n, 3)
  } finally {
    await query('RESET search_path'); await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release(); await pool.end()
  }
})
