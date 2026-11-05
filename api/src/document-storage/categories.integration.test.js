import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { initAiDb } from '../ai.js'
import { registerCategoryRoutes } from '../categories/routes.js'
import { createDocumentStorageRepository } from './repository.js'
import { createDocumentStorage } from './service.js'
import { initDocumentStorage } from './migration.js'
import { defaultDocumentStorage } from './config.js'
const url = process.env.API_TEST_DATABASE_URL
test('category metadata admits atomically by owner/platform bytes and retains archives without content revisions', { skip: !url }, async t => {
  const schema = 'category_storage_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args), transaction = createTransaction(pool)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,yaml text,created_by uuid)')
  await q('CREATE TABLE blocks(id uuid PRIMARY KEY,name text,owner_id uuid,category_slug text,subcategory_slug text,deleted_at timestamptz)')
  await q('CREATE TABLE project_revisions(project_id uuid,revision int,yaml text,summary text)')
  await q('CREATE TABLE block_versions(block_id uuid,yaml text,summary text)')
  await q('CREATE TABLE sync_jobs(kind text,record_id uuid,yaml text,target_repository text,target_branch text)')
  await q('CREATE TABLE block_categories(id uuid PRIMARY KEY,slug text UNIQUE,name text,name_key text,parent_id uuid,icon text,deleted_at timestamptz,owner_id uuid)')
  await initAiDb(q); await initDocumentStorage(q)
  const storage = createDocumentStorage({ repository: createDocumentStorageRepository(q), transaction }), owner = crypto.randomUUID(), other = crypto.randomUUID()
  const configure = async patch => storage.configure({ ...defaultDocumentStorage, ...patch, expectedVersion: (await storage.configuration()).version })
  const app = express(); app.use(express.json())
  app.use((req, _res, next) => { req.user = { id: req.get('x-user') || owner, role: req.get('x-role') || 'dev' }; next() })
  registerCategoryRoutes(app, { query: q, transaction, storage })
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const request = async (body, { method = 'POST', id = owner, role = 'dev', path = '' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/categories${path}`, { method, headers: { 'content-type': 'application/json', 'x-user': id, 'x-role': role }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  const input = { name: 'Fixture ñ', icon: 'cube', scope: 'personal' }
  assert.equal((await request(input, { role: 'view' })).status, 403)
  assert.equal((await request({ ...input, scope: 'catalog' })).status, 403)
  await configure({ userBytes: 0 })
  assert.equal((await request(input)).status, 409)
  assert.equal((await storage.configuration()).usage.categories, '0')
  await configure({})
  const probe = await request(input); assert.equal(probe.status, 201)
  const cost = Number((await storage.summary(owner)).usage.bytes)
  assert.equal(cost, 512 + Buffer.byteLength(probe.body.name) + Buffer.byteLength('fixture n') + Buffer.byteLength(probe.body.slug) + 4)
  await q('DELETE FROM block_categories')
  await configure({ userBytes: cost - 1 }); assert.equal((await request(input)).status, 409)
  await configure({ userBytes: cost })
  const created = await request(input); assert.equal(created.status, 201)
  assert.equal((await request({ name: 'A much longer category', icon: 'battery' }, { method: 'PATCH', path: '/' + created.body.id })).status, 409)
  assert.deepEqual((await q('SELECT name,icon FROM block_categories')).rows[0], { name: input.name, icon: 'cube' })
  const beforeArchive = (await storage.summary(owner)).usage
  await configure({ userBytes: 0 })
  assert.equal((await request(null, { method: 'DELETE', path: '/' + created.body.id })).status, 200)
  assert.deepEqual((await storage.summary(owner)).usage, beforeArchive)
  await q('DELETE FROM block_categories')
  await configure({ platformBytes: cost })
  const race = await Promise.all([request(input), request(input, { id: other })])
  assert.deepEqual(race.map(result => result.status).sort(), [201, 409])
  assert.equal((await storage.configuration()).usage.categories, '1')
  assert.equal((await storage.configuration()).usage.bytes, String(cost))
  const winner = race.find(result => result.status === 201).body
  await configure({})
  assert.equal((await request({ name: 'Child', parentId: winner.id }, { id: winner.owner_id })).status, 201)
  assert.equal((await request({ name: 'Foreign child', parentId: winner.id }, { id: winner.owner_id === owner ? other : owner })).status, 400)
  const catalog = await request({ name: 'Catalog', scope: 'catalog', icon: 'power' }, { role: 'Admin' })
  assert.equal(catalog.status, 201); assert.equal(catalog.body.owner_id, null)
  assert.equal((await storage.configuration()).usage.categories, '3')
  assert.equal((await storage.summary(winner.owner_id)).usage.categories, '2')
  assert.equal((await request({ name: 'Renamed', icon: 'battery' }, { method: 'PATCH', path: '/' + winner.id, id: winner.owner_id })).status, 200)
  assert.equal((await q('SELECT count(*) AS total FROM project_revisions')).rows[0].total, '0')
  assert.equal((await q('SELECT count(*) AS total FROM block_versions')).rows[0].total, '0')
  await initDocumentStorage(q); assert.equal((await storage.configuration()).usage.categories, '3')
  await q('DELETE FROM block_categories')
  const project = crypto.randomUUID(); await q("INSERT INTO projects VALUES($1,'','',$2)", [project, owner])
  await configure({ platformBytes: cost })
  const mixed = await Promise.allSettled([
    (async () => { const result = await request(input); if (result.status !== 201) throw Object.assign(Error('quota'), { status: result.status }); return result })(),
    storage.write('project', project, tx => tx("INSERT INTO project_revisions VALUES($1,1,repeat('d',$2),'')", [project, cost])),
  ])
  assert.equal(mixed.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(mixed.find(result => result.status === 'rejected').reason.status, 409)
  assert.equal((await storage.configuration()).usage.bytes, String(cost))
  await q('INSERT INTO block_categories(id,owner_id) VALUES($1,$2)', [crypto.randomUUID(), other])
  assert.equal((await storage.configuration()).usage.bytes, String(cost + 512))
})
