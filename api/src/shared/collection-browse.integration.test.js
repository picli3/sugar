import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { initCollectionMetadata } from './collection-metadata.js'
import { browseCollection, collectionInput } from './collection-browse.js'

test('collection filters reject malformed dates, ranges, sorting and mismatched cursors', () => {
  for (const query of [
    { sort: 'name; DROP TABLE projects' }, { direction: 'up' }, { limit: '101' }, { name: ['x'] },
    { createdFrom: '2026-02-30' }, { modifiedTo: '0000-01-01' },
    { createdFrom: '2026-05-02', createdTo: '2026-05-01' }, { minBytes: '-1' },
    { minBytes: '20', maxBytes: '1' }, { cursor: 'not-json' }, { unknown: 'x' },
  ]) assert.throws(() => collectionInput(query), { status: 400 })
})

const url = process.env.API_TEST_DATABASE_URL
test('project and image browsing sorts and filters the full authorized collection with stable page boundaries', { skip: !url }, async t => {
  const schema = 'collection_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args)
  t.after(async () => { await pool.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q(`CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int DEFAULT 1,yaml text,created_at timestamptz DEFAULT now(),
    visibility text DEFAULT 'private',created_by uuid,sync_repository text,sync_branch text,settings_version int DEFAULT 1,deleted_at timestamptz)`)
  await q(`CREATE TABLE images(id uuid PRIMARY KEY,name text,mime text DEFAULT 'image/png',data bytea,created_at timestamptz DEFAULT now(),
    created_by uuid,owner_id uuid,scope text DEFAULT 'personal',deleted_at timestamptz)`)
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text)')
  await q('CREATE TABLE project_favorites(project_id uuid,user_id uuid)')
  await q('CREATE TABLE project_revisions(project_id uuid,created_at timestamptz)')
  await q('CREATE TABLE project_settings_history(project_id uuid,created_at timestamptz)')
  const a = { id: crypto.randomUUID(), role: 'dev' }, b = { id: crypto.randomUUID(), role: 'view' }
  await q("INSERT INTO users VALUES($1,'Owner','owner@example.invalid'),($2,'Reader','reader@example.invalid')", [a.id, b.id])
  const ids = Array.from({ length: 41 }, () => crypto.randomUUID())
  for (const [i, id] of ids.entries()) {
    const date = '2026-01-' + String(1 + i % 20).padStart(2, '0') + 'T00:00:00.123456Z'
    await q(`INSERT INTO projects(id,name,yaml,created_at,created_by,visibility) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, 'Project ' + String(i).padStart(2, '0'), 'é'.repeat(i + 1), date, i < 36 ? a.id : b.id, i === 36 ? 'public' : 'private'])
    await q('INSERT INTO images(id,name,data,created_at,owner_id,created_by,scope) VALUES($1,$2,$3,$4,$5,$5,$6)',
      [id, 'Image ' + String(i).padStart(2, '0'), Buffer.alloc(i + 1), date, i < 36 ? a.id : b.id, i === 36 ? 'catalog' : 'personal'])
  }
  await q("INSERT INTO project_members VALUES($1,$2,'reader')", [ids[37], a.id])
  await q("INSERT INTO project_revisions VALUES($1,'2026-03-01T00:00:00Z')", [ids[0]])
  await q("INSERT INTO project_settings_history VALUES($1,'2026-04-01T00:00:00Z')", [ids[0]])
  await initCollectionMetadata(q)
  assert.equal((await q('SELECT updated_at FROM projects WHERE id=$1', [ids[0]])).rows[0].updated_at.toISOString(), '2026-04-01T00:00:00.000Z')
  const before = (await q('SELECT xmin::text FROM projects ORDER BY id')).rows
  await initCollectionMetadata(q)
  assert.deepEqual((await q('SELECT xmin::text FROM projects ORDER BY id')).rows, before)
  for (const kind of ['project', 'image']) {
    const read = query => browseCollection(q, kind, a, query)
    for (const sort of ['name', 'created', 'modified', 'size']) for (const direction of ['asc', 'desc']) {
      const expected = (await read({ sort, direction, limit: '100' })).items
      const seen = []
      let cursor
      do {
        const page = await read({ sort, direction, limit: '7', ...(cursor ? { cursor } : {}) })
        seen.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      assert.deepEqual(seen, expected)
      assert.equal(seen.length, kind === 'project' ? 38 : 37)
      assert.equal(new Set(seen.map(item => item.id)).size, seen.length)
      assert.ok(seen.every(item => !('yaml' in item) && !('data' in item) && !('cursor_key' in item)))
      const column = { name: 'name', created: 'created_at', modified: 'updated_at', size: 'size_bytes' }[sort]
      for (let i = 1; i < seen.length; i++) {
        const left = seen[i - 1][column], right = seen[i][column]
        assert.ok(direction === 'asc' ? left <= right : left >= right)
      }
    }
    const target = kind === 'project' ? 'Project 35' : 'Image 35'
    const filtered = await read({ name: target, sort: 'name' })
    assert.deepEqual(filtered.items.map(item => item.id), [ids[35]])
    assert.deepEqual((await read({ name: '%' })).items, [])
    assert.equal((await read({ minBytes: kind === 'project' ? '72' : '36', maxBytes: kind === 'project' ? '72' : '36' })).items[0].id, ids[35])
    assert.ok((await read({ createdFrom: '2026-01-16', createdTo: '2026-01-16' })).items.every(item => new Date(item.created_at).getUTCDate() === 16))
    assert.equal((await browseCollection(q, kind, { ...a, role: 'Admin' }, { limit: '100' })).items.length, 41)
    const first = await read({ sort: 'name', limit: '1' })
    await assert.rejects(read({ sort: 'size', cursor: first.nextCursor }), { status: 400 })
  }
  await q('INSERT INTO project_favorites VALUES($1,$2),($3,$2)', [ids[35], a.id, ids[0]])
  const favoritePage = await browseCollection(q, 'project', a, { sort: 'size', direction: 'asc', limit: '1' })
  assert.equal(favoritePage.items[0].id, ids[0])
  const next = await browseCollection(q, 'project', a, { sort: 'size', direction: 'asc', limit: '1', cursor: favoritePage.nextCursor })
  assert.equal(next.items[0].id, ids[35])
  assert.equal((await browseCollection(q, 'project', a, { sort: 'size', direction: 'asc', limit: '1', cursor: next.nextCursor })).items[0].id, ids[1])
  await q('UPDATE projects SET yaml=$2 WHERE id=$1', [ids[0], 'new content'])
  const changed = (await browseCollection(q, 'project', a, { name: 'Project 00' })).items[0]
  assert.equal(changed.size_bytes, 11)
  assert.ok(new Date(changed.updated_at) > new Date('2026-04-01'))
  await q('DELETE FROM project_members WHERE project_id=$1', [ids[37]])
  assert.equal((await browseCollection(q, 'project', a, { name: 'Project 37' })).items.length, 0)
  await q('UPDATE images SET deleted_at=now() WHERE id=$1', [ids[35]])
  assert.equal((await browseCollection(q, 'image', a, { name: 'Image 35' })).items.length, 0)
})
