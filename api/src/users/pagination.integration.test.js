import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import pg from 'pg'
import { createUserRepository } from './repository.js'
import { createUserService } from './service.js'
import { registerUserRoutes } from './routes.js'
import { createProjectRepository } from '../projects/repository.js'
import { createProjectService } from '../projects/service.js'
import { registerProjectRoutes } from '../projects/routes.js'
const url = process.env.API_TEST_DATABASE_URL
test('account and collaborator pages bound metadata, retain ACL and continue by immutable UUID', { skip: !url }, async t => {
  const schema = 'people_page_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), statements = [], q = (sql, args) => { statements.push(sql); return pool.query(sql, args) }
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text,role text,active boolean,created_at timestamptz DEFAULT now(),password_hash text,closed_at timestamptz)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int,yaml text,visibility text,created_by uuid,sync_repository text,sync_branch text,settings_version int,created_at timestamptz,deleted_at timestamptz)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text,PRIMARY KEY(project_id,user_id))')
  const owner = crypto.randomUUID(), outsider = crypto.randomUUID(), p = crypto.randomUUID(), other = crypto.randomUUID()
  await q("INSERT INTO users(id,email,role,active,password_hash) VALUES($1,'owner@example.invalid','Admin',true,'private hash'),($2,'other@example.invalid','dev',true,'private hash')", [owner, outsider])
  await q("INSERT INTO users(id,email,role,active,password_hash) SELECT ('00000000-0000-0000-0000-'||lpad(to_hex(i),12,'0'))::uuid,'fixture-'||i||'@example.invalid','view',i%2=0,'private hash' FROM generate_series(1,67) i")
  await q("INSERT INTO projects(id,created_by,visibility) VALUES($1,$2,'private'),($3,$4,'public')", [p, owner, other, outsider])
  await q("INSERT INTO project_members SELECT $1,id,'reader' FROM users WHERE id<>$2 AND id<>$3", [p, owner, outsider])
  const service = createUserService(createUserRepository(q)), projects = createProjectService({ projects: createProjectRepository(q) }), app = express()
  app.use((req, _res, next) => { req.user = { id: req.get('x-user') || owner, role: req.get('x-role') || 'Admin' }; next() })
  registerUserRoutes(app, service); registerProjectRoutes(app, projects)
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const request = async (path, role = 'Admin', id = owner) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { 'x-user': id, 'x-role': role } })
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
  }
  const before = (await q('SELECT id FROM users ORDER BY id')).rows.map(row => row.id)
  let page = await request('/users/page?limit=2'), seen = []
  assert.equal(page.status, 200); assert.equal(page.cache, 'private, no-store')
  await q("INSERT INTO users(id,email,role,active) VALUES('00000000-0000-0000-0000-000000000000','new@example.invalid','view',true)")
  await q("UPDATE users SET email='renamed@example.invalid',active=false WHERE id=$1", [before[0]])
  do {
    seen.push(...page.body.items.map(row => row.id)); assert.ok(page.body.items.every(row => row.password_hash === undefined))
    if (!page.body.nextCursor) break
    page = await request('/users/page?limit=2&cursor=' + page.body.nextCursor)
  } while (true)
  assert.deepEqual(seen, before)
  statements.length = 0
  for (const role of ['dev','view']) assert.equal((await request('/users/page', role)).status, 403)
  assert.equal(statements.some(sql => sql.includes('metadata_source')), false)
  for (const query of ['limit=101','cursor=bad','cursor[]=x','scope=all']) assert.equal((await request('/users/page?' + query)).status, 400)
  const memberPath = `/projects/${p}/members`, expected = before.filter(id => id !== owner && id !== outsider)
  page = await request(memberPath + '/page?limit=3', 'dev'); seen = []
  assert.equal(page.status, 200); assert.equal(page.cache, 'private, no-store')
  do {
    seen.push(...page.body.items.map(row => row.user_id)); assert.ok(page.body.items.every(row => row.id === undefined && row.password_hash === undefined))
    if (!page.body.nextCursor) break
    page = await request(memberPath + '/page?limit=3&cursor=' + page.body.nextCursor, 'dev')
  } while (true)
  assert.deepEqual(seen, expected)
  statements.length = 0
  assert.equal((await request(memberPath + '/page', 'dev', expected[0])).status, 403)
  assert.equal((await request(memberPath + '/page', 'view', outsider)).status, 403)
  assert.equal((await request(`/projects/${other}/members/page`, 'dev')).status, 403)
  assert.equal(statements.some(sql => sql.includes('metadata_source')), false)
  assert.equal((await request(`/projects/${other}/members/page`)).status, 200)
  assert.equal((await request(memberPath, 'dev')).body.length, 67)
  assert.equal((await request('/users')).body.length, 70)
  await q("UPDATE users SET email=repeat('ñ',2097153) WHERE id=$1", [expected[0]])
  assert.equal((await request(memberPath + '/page', 'dev')).status, 413)
  assert.equal((await request(memberPath, 'dev')).status, 413)
  assert.equal((await request('/users')).status, 413)
  await q("UPDATE users SET email='repaired@example.invalid' WHERE id=$1", [expected[0]])
  await q("INSERT INTO users(id,email,role,active) SELECT gen_random_uuid(),'extra-'||i||'@example.invalid','view',true FROM generate_series(1,1001) i")
  await q("INSERT INTO project_members SELECT $1,id,'reader' FROM users WHERE email LIKE 'extra-%'", [p])
  assert.equal((await request('/users')).status, 413)
  assert.equal((await request(memberPath, 'dev')).status, 413)
  assert.equal((await request('/users/page?limit=100')).body.items.length, 100)
  assert.equal((await request(memberPath + '/page?limit=100', 'dev')).body.items.length, 100)
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1', [p])
  assert.equal((await request(memberPath + '/page', 'dev')).status, 404)
})
