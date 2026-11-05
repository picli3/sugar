import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { migrateLibraryOwnership } from './migration.js'
const url = process.env.API_TEST_URL
const databaseUrl = process.env.API_TEST_DATABASE_URL
const password = 'isolated-library-password'
const doc = category => ({ name: 'Private block', function: 'Measure', category, ports: [{ id: 'power', label: '3V3', protocol: 'POWER', direction: 'in' }] })

test('personal libraries and administered catalog stay isolated through HTTP', { skip: !url }, async t => {
  const suffix = crypto.randomUUID().slice(0, 8)
  async function req(path, cookie, method = 'GET', body) {
    const res = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const json = (res.headers.get('content-type') || '').includes('application/json')
    return { status: res.status, body: json ? await res.json() : await res.text(), cookie: res.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (email, pass = password) => { const r = await req('/login', null, 'POST', { email, password: pass }); assert.equal(r.status, 200); return r.cookie }
  const admin = await login('admin@local', 'local-icons-verification-password'), users = []
  for (const name of ['a', 'b']) {
    const email = `library-${name}-${suffix}@local`
    const r = await req('/users', admin, 'POST', { email, password, role: 'dev' }); assert.equal(r.status, 201)
    users.push({ ...r.body, cookie: await login(email) })
  }
  const [a, b] = users
  let ca, cb, sub, blockId, catalogId
  await t.test('personal category names can repeat across owners and global scope stays administered', async () => {
    ca = (await req('/categories', a.cookie, 'POST', { name: 'Sensores', icon: 'sensor' })).body
    cb = (await req('/categories', b.cookie, 'POST', { name: 'Sensores', icon: 'sensor' })).body
    assert.equal(ca.owner_id, a.id); assert.equal(cb.owner_id, b.id); assert.notEqual(ca.slug, cb.slug)
    assert.equal((await req('/categories', a.cookie, 'POST', { name: 'Sensores', icon: 'sensor' })).status, 409)
    sub = (await req('/categories', a.cookie, 'POST', { name: 'Private child', parentId: ca.id, icon: null })).body
    assert.equal(sub.owner_id, a.id)
    assert.equal((await req('/categories', b.cookie, 'POST', { name: 'Wrong owner', parentId: ca.id, icon: null })).status, 400)
    assert.equal((await req('/categories', a.cookie, 'POST', { name: 'Catalog denied', scope: 'catalog', icon: 'sensor' })).status, 403)
    const listedA = (await req('/categories', a.cookie)).body, listedB = (await req('/categories', b.cookie)).body
    assert.equal(listedA.some(c => c.id === cb.id), false); assert.equal(listedB.some(c => c.id === ca.id), false)
    assert.equal((await req('/categories/' + ca.id, b.cookie, 'PATCH', { name: 'Denied' })).status, 404)
    assert.equal((await req('/categories/' + ca.id, b.cookie, 'DELETE')).status, 404)
    const global = listedA.find(c => c.slug === 'sensores')
    assert.equal(global.owner_id, null); assert.equal(global.permissions.canEdit, false)
    assert.equal((await req('/categories/' + global.id, a.cookie, 'PATCH', { name: 'Denied' })).status, 403)
    assert.equal((await req('/categories/' + global.id, a.cookie, 'DELETE')).status, 403)
  })
  await t.test('private blocks, versions and diffs are inaccessible to another account', async () => {
    const block = { ...doc(ca.slug), subcategory: sub.slug }
    const created = await req('/blocks', a.cookie, 'POST', { yaml: JSON.stringify(block), owner_id: b.id }); assert.equal(created.status, 201); blockId = created.body.id
    assert.equal((await req('/blocks', b.cookie, 'POST', { yaml: JSON.stringify(block) })).status, 400)
    const own = (await req('/blocks', a.cookie)).body.find(x => x.id === blockId)
    assert.equal(own.owner_id, a.id); assert.equal(own.permissions.canEdit, true)
    assert.equal((await req('/blocks', b.cookie)).body.some(x => x.id === blockId), false)
    const path = '/blocks/' + blockId
    for (const suffix of ['/versions', '/versions/1', '/diff?from=1&to=1']) assert.equal((await req(path + suffix, b.cookie)).status, 404)
    assert.equal((await req(path, b.cookie, 'PUT', { yaml: JSON.stringify(block), expectedVersion: 1 })).status, 404)
    assert.equal((await req(path + '/restore', b.cookie, 'POST', { version: 1, expectedVersion: 1 })).status, 404)
    assert.equal((await req('/validate', b.cookie, 'POST', { kind: 'block', yaml: JSON.stringify(block), blockId })).status, 404)
    assert.equal((await req('/categories/' + ca.id, a.cookie, 'DELETE')).status, 409)
  })
  await t.test('shared catalog is readable and only Admin can create or update it', async () => {
    const yaml = JSON.stringify(doc('sensores'))
    assert.equal((await req('/blocks', a.cookie, 'POST', { yaml, scope: 'catalog' })).status, 403)
    const created = await req('/blocks', admin, 'POST', { yaml, scope: 'catalog' }); assert.equal(created.status, 201); catalogId = created.body.id
    const path = '/blocks/' + catalogId
    for (const account of users) {
      const item = (await req('/blocks', account.cookie)).body.find(x => x.id === catalogId)
      assert.equal(item.owner_id, null); assert.equal(item.permissions.canEdit, false)
      assert.equal((await req(path + '/versions/1', account.cookie)).status, 200)
      assert.equal((await req(path, account.cookie, 'PUT', { yaml, expectedVersion: 1 })).status, 403)
      assert.equal((await req(path + '/restore', account.cookie, 'POST', { version: 1, expectedVersion: 1 })).status, 403)
    }
    assert.deepEqual((await req(path, admin, 'PUT', { yaml, expectedVersion: 1 })).body, { version: 2 })
    assert.equal((await req('/blocks', admin, 'POST', { yaml: JSON.stringify(doc(ca.slug)), scope: 'catalog' })).status, 400)
  })
  await t.test('owner can update/restore; category metadata and project copies preserve history', async () => {
    const block = { ...doc(ca.slug), subcategory: sub.slug }, path = '/blocks/' + blockId
    const diagram = { name: 'Library snapshot ' + suffix, nodes: [{ id: 'n', position: { x: 0, y: 0 }, block, libraryId: blockId, libraryVersion: 1 }], edges: [] }
    const project = (await req('/projects', a.cookie, 'POST', { yaml: JSON.stringify(diagram) })).body
    assert.deepEqual((await req(path, a.cookie, 'PUT', { yaml: JSON.stringify({ ...block, name: 'Updated' }), expectedVersion: 1, owner_id: b.id })).body, { version: 2 })
    assert.equal((await req(path, a.cookie, 'PUT', { yaml: JSON.stringify(block), expectedVersion: 1 })).status, 409)
    assert.equal((await req(path, a.cookie, 'PUT', { yaml: JSON.stringify(doc(cb.slug)), expectedVersion: 2 })).status, 400)
    assert.deepEqual((await req(path + '/restore', a.cookie, 'POST', { version: 1, expectedVersion: 2 })).body, { version: 3 })
    assert.equal((await req(path + '/versions', a.cookie)).body.length, 3)
    assert.match((await req(path + '/diff?from=1&to=2', a.cookie)).body, /block.yaml/)
    assert.equal((await req('/categories/' + ca.id, a.cookie, 'PATCH', { name: 'My sensors', icon: 'battery' })).body.slug, ca.slug)
    const saved = (await req('/projects/' + project.id, a.cookie)).body
    assert.equal(saved.revision, 1); assert.deepEqual(JSON.parse(saved.yaml), diagram)
    await req('/projects/' + project.id + '/settings', a.cookie, 'PATCH', { visibility: 'public', expectedSettingsVersion: 1 })
    assert.deepEqual((await req('/public/projects/' + project.id)).body.category_icons, { [ca.slug]: 'battery', [sub.slug]: null })
    assert.equal((await req('/blocks', a.cookie)).body.find(x => x.id === blockId).owner_id, a.id)
  })
  await t.test('global view role cannot write its personal resources; Admin can support them', async () => {
    const path = '/blocks/' + blockId, yaml = JSON.stringify({ ...doc(ca.slug), subcategory: sub.slug })
    assert.equal((await req('/validate', admin, 'POST', { kind: 'block', yaml, blockId })).status, 200)
    assert.deepEqual((await req(path, admin, 'PUT', { yaml, expectedVersion: 3 })).body, { version: 4 })
    assert.equal((await req('/users/' + a.id, admin, 'PATCH', { role: 'view' })).status, 200)
    assert.equal((await req(path + '/versions', a.cookie)).status, 200)
    assert.equal((await req(path, a.cookie, 'PUT', { yaml, expectedVersion: 4 })).status, 403)
    assert.equal((await req('/categories/' + ca.id, a.cookie, 'PATCH', { name: 'Denied' })).status, 403)
    assert.equal((await req('/blocks', a.cookie)).body.find(x => x.id === blockId).permissions.canEdit, false)
  })
})

test('ownership migration preserves legacy records, versions and diagram references', { skip: !databaseUrl }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl }), client = await pool.connect()
  const schema = 'library_migration_' + crypto.randomUUID().replaceAll('-', '')
  const query = (sql, args) => client.query(sql, args)
  const transaction = createTransaction({ connect: async () => ({ query, release() {} }) })
  try {
    await query(`CREATE SCHEMA ${schema}`); await query(`SET search_path TO ${schema}`)
    await query('CREATE TABLE users(id uuid PRIMARY KEY,display_name text)')
    await query('CREATE TABLE blocks(id uuid PRIMARY KEY,name text,latest_version integer,deleted_at timestamptz)')
    await query('CREATE TABLE block_categories(id uuid PRIMARY KEY,slug text UNIQUE,name text,name_key text,parent_id uuid,deleted_at timestamptz)')
    await query(`CREATE UNIQUE INDEX block_categories_sibling_name ON block_categories(coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),name_key) WHERE deleted_at IS NULL`)
    await query('CREATE TABLE block_versions(block_id uuid,version integer,yaml text,author_id uuid)')
    await query('CREATE TABLE project_revisions(project_id uuid,revision integer,yaml text)')
    const ownerA = crypto.randomUUID(), ownerB = crypto.randomUUID(), id = crypto.randomUUID(), catId = crypto.randomUUID(), yaml = JSON.stringify(doc('legacy'))
    await query('INSERT INTO users VALUES($1),($2)', [ownerA, ownerB])
    await query("INSERT INTO blocks VALUES($1,'Legacy',1,NULL)", [id])
    await query("INSERT INTO block_categories VALUES($1,'legacy','Legacy','legacy',NULL,NULL)", [catId])
    await query('INSERT INTO block_versions VALUES($1,1,$2,$3)', [id, yaml, ownerA])
    await query('INSERT INTO project_revisions VALUES($1,1,$2)', [crypto.randomUUID(), JSON.stringify({ nodes: [{ libraryId: id, block: doc('legacy') }] })])
    const before = JSON.stringify((await query('SELECT * FROM block_versions')).rows) + JSON.stringify((await query('SELECT * FROM project_revisions')).rows)
    await migrateLibraryOwnership(transaction); await migrateLibraryOwnership(transaction)
    assert.equal((await query('SELECT owner_id FROM blocks')).rows[0].owner_id, null)
    assert.equal((await query('SELECT owner_id,slug FROM block_categories')).rows[0].owner_id, null)
    assert.equal((await query('SELECT slug FROM block_categories')).rows[0].slug, 'legacy')
    assert.equal(JSON.stringify((await query('SELECT * FROM block_versions')).rows) + JSON.stringify((await query('SELECT * FROM project_revisions')).rows), before)
    for (const owner of [ownerA, ownerB]) await query("INSERT INTO block_categories(id,slug,name,name_key,owner_id) VALUES($1,$2,'Legacy','legacy',$3)", [crypto.randomUUID(), 'personal-' + owner, owner])
    await assert.rejects(query("INSERT INTO block_categories(id,slug,name,name_key,owner_id) VALUES($1,'duplicate','Legacy','legacy',$2)", [crypto.randomUUID(), ownerA]), { code: '23505' })
  } finally {
    await query('RESET search_path'); await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release(); await pool.end()
  }
})
