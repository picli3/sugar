import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createImageRepository } from './repository.js'
import { createImageService } from './service.js'
import { initGalleryPaginationDb } from './pagination.js'
const url = process.env.API_TEST_DATABASE_URL
test('gallery keysets keep ACLs, precision and stable ties without duplicates or skipping metadata', { skip: !url }, async t => {
  const schema = 'gallery_page_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q('CREATE TABLE images(id uuid PRIMARY KEY,name text,mime text,scope text,owner_id uuid,created_by uuid,created_at timestamptz,deleted_at timestamptz)')
  await initGalleryPaginationDb(q); await initGalleryPaginationDb(q)
  const a = { id: crypto.randomUUID(), role: 'dev' }, b = { id: crypto.randomUUID(), role: 'dev' }, ids = []
  for (let i = 0; i < 9; i++) {
    const id = crypto.randomUUID(); ids.push(id)
    await q("INSERT INTO images VALUES($1,$2,'image/png',$3,$4,NULL,'2026-01-01 00:00:00.123456+00'::timestamptz+($5::int*interval '1 microsecond'),NULL)", [id, 'Fixture ' + i, i === 8 ? 'catalog' : 'personal', i === 8 ? null : i < 6 ? a.id : b.id, i < 3 ? 0 : i])
  }
  const service = createImageService(createImageRepository(q)), seen = []
  let cursor
  do {
    const page = await service.page(a, { limit: '2', ...(cursor ? { cursor } : {}) })
    assert.ok(page.items.length <= 2)
    for (const row of page.items) { assert.equal(row.cursor_time, undefined); assert.match(row.url, /^\/api\/images\//); seen.push(row.id) }
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(new Set(seen).size, 7); assert.deepEqual([...seen].sort(), [...ids.slice(0,6), ids[8]].sort())
  const foreign = (await service.page(b, { limit: '1' })).nextCursor
  assert.ok((await service.page(a, { cursor: foreign })).items.every(row => !ids.slice(6,8).includes(row.id)))
  assert.equal((await service.page({ ...a, role: 'Admin' }, { limit: '100' })).items.length, 9)
  // A catalog row with a legacy owner must still appear exactly once.
  await q('UPDATE images SET owner_id=$1 WHERE id=$2', [a.id, ids[8]])
  assert.equal((await service.page(a, { limit: '100' })).items.length, 7)
  let statement, params
  await createImageRepository(async (sql, args) => { statement = sql; params = args; return q(sql, args) }).page(a, { limit: 2, after: null })
  const raw = await q(statement, params); assert.ok(raw.rows.length <= 3)
  // Check index eligibility, not a production load/latency claim.
  await q('SET enable_seqscan=off')
  const plan = JSON.stringify((await q('EXPLAIN (FORMAT JSON) ' + statement, params)).rows)
  assert.match(plan, /images_page_personal/); assert.match(plan, /images_page_catalog/)
  await q('RESET enable_seqscan')
  await q('UPDATE images SET deleted_at=now() WHERE id=$1', [ids[0]])
  assert.equal((await service.page(a, {})).items.length, 6)
})
