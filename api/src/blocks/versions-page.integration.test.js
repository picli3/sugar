import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createBlockRepository } from './repository.js'
import { createBlockService } from './service.js'
const url = process.env.API_TEST_DATABASE_URL
test('block version pages enforce live library access, integer boundaries and metadata-only reads', { skip: !url }, async t => {
  const schema = 'versions_page_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), statements = [], q = (sql,args) => { statements.push(sql); return pool.query(sql,args) }
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q('CREATE TABLE blocks(id uuid PRIMARY KEY,owner_id uuid,deleted_at timestamptz)')
  await q('CREATE TABLE block_versions(block_id uuid,version int,summary text,created_at timestamptz DEFAULT now(),author_id uuid,yaml text,PRIMARY KEY(block_id,version))')
  const a={id:crypto.randomUUID(),role:'dev'}, b={id:crypto.randomUUID(),role:'view'}, adminUser={id:crypto.randomUUID(),role:'Admin'}, block=crypto.randomUUID(), catalog=crypto.randomUUID(), foreign=crypto.randomUUID()
  await q("INSERT INTO users VALUES($1,'first@example.invalid'),($2,'second@example.invalid')", [a.id,b.id])
  await q('INSERT INTO blocks VALUES($1,$2,NULL),($3,NULL,NULL),($4,$5,NULL)',[block,a.id,catalog,foreign,b.id])
  await q("INSERT INTO block_versions SELECT $1,i,'Fixture '||i,now(),$2,'private version bytes' FROM generate_series(1,67) i",[block,a.id])
  await q("INSERT INTO block_versions VALUES($1,500,'Catalog fixture',now(),$3,'catalog bytes'),($2,600,'Foreign fixture',now(),$3,'other private bytes')",[catalog,foreign,b.id])
  const service=createBlockService({blocks:createBlockRepository(q)}), seen=[]
  let page=await service.versionsPage(block,a,{limit:'30'})
  assert.equal(page.items.length,30); assert.equal(page.nextCursor,'38')
  await q("INSERT INTO block_versions VALUES($1,68,'Later insert',now(),$2,'later bytes')",[block,a.id])
  while(true){seen.push(...page.items.map(i=>i.version));assert.ok(page.items.every(i=>i.yaml===undefined));if(!page.nextCursor)break;page=await service.versionsPage(block,a,{limit:'30',cursor:page.nextCursor})}
  assert.deepEqual(seen,Array.from({length:67},(_,i)=>67-i))
  assert.equal((await service.versionsPage(block,a,{})).items[0].version,68)
  statements.length=0
  await assert.rejects(service.versionsPage(block,b,{cursor:'2'}),{status:404})
  assert.equal(statements.some(sql=>sql.includes('FROM block_versions')),false)
  assert.equal((await service.versionsPage(catalog,b,{})).items[0].version,500)
  assert.equal((await service.versionsPage(foreign,b,{})).items[0].version,600)
  assert.equal((await service.versionsPage(block,adminUser,{cursor:'2'})).items[0].version,1)
  assert.ok(statements.every(sql=>!sql.includes('v.yaml')))
  await assert.rejects(service.versionsPage(foreign,a,{cursor:'38'}),{status:404})
  await q('UPDATE blocks SET owner_id=$2 WHERE id=$1',[block,b.id])
  await assert.rejects(service.versionsPage(block,a,{cursor:'38'}),{status:404})
  await q('UPDATE blocks SET deleted_at=now() WHERE id=$1',[block])
  await assert.rejects(service.versionsPage(block,adminUser,{}),{status:404})
})
