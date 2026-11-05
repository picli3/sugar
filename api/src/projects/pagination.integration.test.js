import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createProjectRepository } from './repository.js'
import { createProjectService } from './service.js'
import { initProjectPaginationDb } from './pagination.js'
const url = process.env.API_TEST_DATABASE_URL
test('project pages preserve owner/public/member/Admin boundaries with disjoint candidates and stable cursors', { skip: !url }, async t => {
  const schema = 'projects_page_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int,created_at timestamptz,visibility text,created_by uuid,sync_repository text,sync_branch text,settings_version int,deleted_at timestamptz,yaml text,share_token text)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text,PRIMARY KEY(project_id,user_id))')
  await q('CREATE INDEX project_members_user ON project_members(user_id,project_id)')
  await initProjectPaginationDb(q); await initProjectPaginationDb(q)
  const a = { id: crypto.randomUUID(), role: 'dev' }, b = { id: crypto.randomUUID(), role: 'view' }, ids = []
  await q("INSERT INTO users VALUES($1,'owner@example.invalid'),($2,'other@example.invalid')", [a.id,b.id])
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomUUID(); ids.push(id)
    await q(`INSERT INTO projects VALUES($1,$2,1,'2026-01-01 00:00:00.123456+00'::timestamptz+($3::int*interval '1 microsecond'),$4,$5,NULL,'main',1,$6,'private diagram bytes','private share token')`,
      [id, 'Fixture ' + i, i < 3 ? 0 : i, [1,5,7,8].includes(i) ? 'public' : 'private', i < 3 ? a.id : i < 8 ? b.id : null, i === 7 ? new Date() : null])
    if ([2,3,4,5,9].includes(i)) await q('INSERT INTO project_members VALUES($1,$2,$3)', [id,a.id,i % 2 ? 'reader' : 'editor'])
  }
  const service = createProjectService({ projects: createProjectRepository(q) }), seen = []
  let cursor
  do {
    const page = await service.page(a, { limit: '2', ...(cursor ? { cursor } : {}) })
    assert.ok(page.items.length <= 2)
    for (const item of page.items) {
      assert.equal(item.yaml, undefined); assert.equal(item.share_token, undefined); assert.equal(item.cursor_time, undefined)
      seen.push(item.id)
    }
    cursor = page.nextCursor
  } while (cursor)
  const expected = [0,1,2,3,4,5,8,9].map(i => ids[i])
  assert.deepEqual([...seen].sort(), expected.sort()); assert.equal(new Set(seen).size, 8)
  const adminPage = await service.page({ ...a, role: 'Admin' }, { limit: '100' }); assert.equal(adminPage.items.length, 9)
  const foreign = (await service.page({ ...b, role: 'Admin' }, { limit: '1' })).nextCursor
  assert.ok((await service.page(a, { cursor: foreign })).items.every(p => expected.includes(p.id)))
  await q('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [ids[3],a.id])
  assert.equal((await service.page({ ...a, role: 'view' }, { limit: '100' })).items.some(p => p.id === ids[3]), false)
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1', [ids[0]])
  assert.equal((await service.page(a, { limit: '100' })).items.length, 6)
  assert.equal((await service.page(b, { limit: '100' })).items.some(p => [ids[0],ids[2],ids[9]].includes(p.id)), false)
})
