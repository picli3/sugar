import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { migrateBlockCatalog } from './catalog.js'
import { createBlockRepository } from './repository.js'
import { createBlockService } from './service.js'

const url = process.env.API_TEST_DATABASE_URL
const id = n => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const block = {
  name: 'Fixture', category: 'sensores', subcategory: 'temperatura',
  model: 'Late model', function: 'Late function',
  ports: [{ id: 'p', label: 'Late port', protocol: 'SPI', direction: 'in' }],
  image: 'https://example.invalid/fixture.png',
  design_block_kicad: '/api/schematics/' + id(800) + '/content',
}

test('catalog covers the visible library, bounds pages, and tracks the current version', { skip: !url }, async t => {
  const schema = 'catalog_' + crypto.randomBytes(8).toString('hex')
  const admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema })
  const q = (sql, args) => pool.query(sql, args)
  const transaction = createTransaction(pool)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q(`CREATE TABLE blocks(id uuid PRIMARY KEY,name text,latest_version int,owner_id uuid,deleted_at timestamptz,category_slug text,subcategory_slug text)`)
  await q(`CREATE TABLE block_versions(block_id uuid,version int,yaml text,author_id uuid,summary text,created_at timestamptz DEFAULT now(),PRIMARY KEY(block_id,version))`)
  const actor = { id: id(900), role: 'dev' }, outsider = { id: id(901), role: 'view' }
  await q(`INSERT INTO blocks(id,name,latest_version,owner_id,deleted_at)
    SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'Block '||n,1,
      CASE WHEN n=128 THEN $2::uuid WHEN n>125 THEN $1::uuid END,CASE WHEN n=129 THEN now() END
    FROM generate_series(1,130) n`, [actor.id, outsider.id])
  await q(`INSERT INTO block_versions(block_id,version,yaml)
    SELECT id,1,CASE WHEN id=$2 THEN repeat('x',2000001) WHEN id=$3 THEN 'not YAML for a block' ELSE $1 END
    FROM blocks WHERE id<>$4`, [JSON.stringify(block), id(1), id(2), id(130)])

  await migrateBlockCatalog(q, transaction)
  const stamp = () => q('SELECT id,xmin::text,catalog_preview FROM blocks ORDER BY id')
  const first = (await stamp()).rows
  await migrateBlockCatalog(q, transaction)
  assert.deepEqual((await stamp()).rows, first)
  assert.equal((await q('SELECT count(*)::int AS n FROM block_versions')).rows[0].n, 129)

  const service = createBlockService({ blocks: createBlockRepository(q), transaction,
    validateCategory: async () => {}, replaceEmbeddedImages: async yaml => yaml })
  const page = (user, cursor) => service.catalogPage(user, { limit: '100', ...(cursor ? { cursor } : {}) })
  const one = await page(actor)
  const two = await page(actor, one.nextCursor)
  assert.equal(one.items.length, 100)
  assert.equal(two.items.length, 27)
  assert.equal(two.nextCursor, null)
  assert.deepEqual(one.items.slice(0,2).map(row => [row.name,row.model]), [['Block 1',''],['Block 2','']])
  const last = two.items.at(-1)
  assert.equal(last.id, id(127))
  assert.equal(last.category, 'sensores')
  assert.equal(last.subcategory, 'temperatura')
  assert.equal(last.model, block.model)
  assert.equal(last.function, block.function)
  assert.match(last.port_terms, /Late port/)
  assert.equal(last.image, block.image)
  assert.equal(last.has_schematic, true)
  assert.ok([...one.items, ...two.items].every(row => !('yaml' in row)))
  const privateIds = async user => (await page(user, id(125))).items.map(row => row.id)
  assert.deepEqual(await privateIds(outsider), [id(128)])
  assert.deepEqual(await privateIds({ ...outsider, role: 'Admin' }), [id(126),id(127),id(128)])

  const created = await service.create(actor, { yaml: JSON.stringify(block) })
  const current = async () => (await q('SELECT catalog_preview FROM blocks WHERE id=$1', [created.id])).rows[0].catalog_preview
  assert.equal((await current()).version, 1)
  await service.save(created.id, actor, { yaml: JSON.stringify({ ...block, model: 'Revised', design_block_kicad: undefined }), expectedVersion: 1 })
  assert.equal((await current()).model, 'Revised')
  assert.equal((await current()).has_schematic, false)
  await assert.rejects(service.save(created.id, actor, { yaml: JSON.stringify(block), expectedVersion: 1 }), { status: 409 })
  assert.equal((await current()).version, 2)
  await service.restore(created.id, actor, { version: 1, expectedVersion: 2 })
  assert.equal((await current()).version, 3)
  assert.equal((await current()).has_schematic, true)

  await q(`UPDATE blocks SET catalog_preview=jsonb_set(catalog_preview,'{port_terms}',to_jsonb(repeat('x',90000))) WHERE id BETWEEN $1 AND $2`, [id(3), id(90)])
  let cursor, seen = []
  do {
    const result = await page(actor, cursor)
    if (!cursor) assert.ok(result.items.length < 100 && result.nextCursor)
    seen.push(...result.items.map(row => row.id))
    cursor = result.nextCursor
  } while (cursor)
  assert.equal(seen.length, 128)
  assert.equal(new Set(seen).size, seen.length)
})
