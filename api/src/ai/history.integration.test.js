import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import pg from 'pg'
import { initAiDb, registerAi } from '../ai.js'
import { createAnalysisHistory } from './history.js'
import { createProjectService } from '../projects/service.js'
import { createProjectRepository } from '../projects/repository.js'
const url = process.env.API_TEST_DATABASE_URL
test('analysis pages preserve microsecond ties, whole metadata, live ACL and legacy bounds', { skip: !url }, async t => {
  const schema = 'analysis_page_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), statements = [], q = (sql, args) => { statements.push(sql); return pool.query(sql, args) }
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,email text)')
  await q("CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int,yaml text,visibility text,created_by uuid,sync_repository text,sync_branch text,settings_version int,created_at timestamptz,deleted_at timestamptz)")
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text)')
  await initAiDb(q); await initAiDb(q)
  const owner = crypto.randomUUID(), reader = crypto.randomUUID(), outsider = crypto.randomUUID(), p = crypto.randomUUID(), other = crypto.randomUUID()
  await q("INSERT INTO users VALUES($1,'owner@example.invalid'),($2,'reader@example.invalid'),($3,'outsider@example.invalid')", [owner, reader, outsider])
  await q("INSERT INTO projects(id,created_by,visibility) VALUES($1,$2,'private'),($3,$4,'private')", [p, owner, other, outsider])
  const insert = async (id, project, i, focus = 'Fixture') => q(`INSERT INTO project_analyses VALUES($1,$2,$3,$4,'{"private":"snapshot"}','hash',1,'analyze',$5,'es','deepseek','deepseek-flash','private response',NULL,'2026-01-01 00:00:00.123456+00'::timestamptz+($6::int*interval '1 microsecond'))`, [id, project, owner, crypto.randomUUID(), focus, i])
  for (let i = 0; i < 67; i++) await insert(crypto.randomUUID(), p, i < 3 ? 0 : i)
  await insert(crypto.randomUUID(), other, 500)
  const expected = (await q('SELECT id FROM project_analyses WHERE project_id=$1 ORDER BY created_at DESC,id DESC', [p])).rows.map(row => row.id)
  const projects = createProjectService({ projects: createProjectRepository(q) }), app = express()
  app.use((req, _res, next) => { req.user = { id: req.get('x-user') || owner, role: req.get('x-role') || 'dev' }; next() })
  registerAi(app, { q, requireProject: req => projects.get(req.params.id, req.user), callProvider: () => { throw Error('No provider calls allowed') } })
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const request = async (suffix = '', user = owner, role = 'dev', project = p) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project}/analyses${suffix}`, { headers: { 'x-user': user, 'x-role': role } })
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
  }
  let page = await request('/page?limit=2'), seen = []
  assert.equal(page.status, 200); assert.equal(page.cache, 'private, no-store')
  assert.equal(JSON.parse(Buffer.from(page.body.nextCursor, 'base64url')).at, '2026-01-01T00:00:00.123521Z')
  await insert(crypto.randomUUID(), p, 999)
  do {
    seen.push(...page.body.items.map(item => item.id))
    assert.ok(page.body.items.every(item => item.snapshot === undefined && item.response === undefined && item.cursor_time === undefined))
    if (!page.body.nextCursor) break
    page = await request('/page?limit=2&cursor=' + page.body.nextCursor)
  } while (true)
  assert.deepEqual(seen, expected)
  statements.length = 0
  assert.equal((await request('/page', reader, 'view')).status, 403)
  assert.equal(statements.some(sql => sql.includes('FROM project_analyses')), false)
  await q("INSERT INTO project_members VALUES($1,$2,'reader')", [p, reader])
  assert.equal((await request('/page?limit=1', reader, 'view')).body.items.length, 1)
  await q('DELETE FROM project_members WHERE project_id=$1', [p])
  assert.equal((await request('/page', reader, 'view')).status, 403)
  assert.equal((await request('/page', owner, 'dev', other)).status, 403)
  assert.equal((await request('/page', outsider, 'Admin')).status, 200)
  await q("UPDATE projects SET visibility='public' WHERE id=$1", [p])
  assert.equal((await request('/page', reader, 'view')).status, 200)
  for (const query of ['limit=101','cursor=invalid','offset=1','limit=1&limit=2']) assert.equal((await request('/page?' + query)).status, 400)
  assert.equal((await request('/' + crypto.randomUUID())).status, 404)
  const history = createAnalysisHistory(q), big = crypto.randomUUID()
  await insert(big, p, 1000, 'ñ'.repeat(1100000))
  await insert(crypto.randomUUID(), p, 1001, 'ñ'.repeat(1100000))
  const short = await history.page(p, { limit: '30' })
  assert.equal(short.items.length, 1); assert.equal(short.items[0].focus.length, 1100000); assert.ok(short.nextCursor)
  const following = await history.page(p, { cursor: short.nextCursor })
  assert.equal(following.items[0].id, big)
  await q('UPDATE project_analyses SET focus=repeat($2,2097153) WHERE id=$1', [big, 'ñ'])
  await assert.rejects(history.page(p, { cursor: short.nextCursor }), { status: 413 })
  await assert.rejects(history.legacy(p, { offset: '1001' }), { status: 400 })
  await q(`INSERT INTO project_analyses SELECT gen_random_uuid(),$1,$2,gen_random_uuid(),'{}','hash',1,'analyze','','es','deepseek','deepseek-flash','',NULL,'2025-01-01'::timestamptz FROM generate_series(1,1021)`, [p, owner])
  await assert.rejects(history.legacy(p, { offset: '1000' }), { status: 413 })
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1', [p])
  assert.equal((await request('/page')).status, 404)
})
