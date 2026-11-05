import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { boundedLegacyList,legacyListBytes } from './legacy-list.js'
import { createProjectRepository } from '../projects/repository.js'
import { createImageRepository } from '../images/repository.js'
import { createBlockRepository } from '../blocks/repository.js'
const url=process.env.API_TEST_DATABASE_URL
test('legacy metadata preserves complete contracts/order and guards count/bytes before JSON aggregation', {skip:!url},async t=>{
  const schema='legacy_lists_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url})
  await admin.query('CREATE SCHEMA '+schema)
  const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema});let last
  const q=(text,args)=>{last={text,args};return pool.query(text,args)}
  t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()})
  await q('CREATE TABLE users(id uuid PRIMARY KEY,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int,created_at timestamptz,visibility text,created_by uuid,sync_repository text,sync_branch text,settings_version int,deleted_at timestamptz)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text)')
  await q('CREATE TABLE images(id uuid PRIMARY KEY,name text,mime text,scope text,owner_id uuid,created_by uuid,created_at timestamptz,deleted_at timestamptz)')
  await q('CREATE TABLE project_revisions(project_id uuid,revision int,summary text,created_at timestamptz,author_id uuid)')
  await q('CREATE TABLE block_versions(block_id uuid,version int,summary text,created_at timestamptz,author_id uuid)')
  await q('CREATE TABLE project_settings_history(id bigint PRIMARY KEY,project_id uuid,before jsonb,after jsonb,created_at timestamptz,author_id uuid)')
  const a={id:crypto.randomUUID(),role:'dev'},b={id:crypto.randomUUID(),role:'view'},p=crypto.randomUUID(),foreign=crypto.randomUUID(),image=crypto.randomUUID(),block=crypto.randomUUID()
  await q("INSERT INTO users VALUES($1,'first@example.invalid'),($2,'second@example.invalid')",[a.id,b.id])
  await q("INSERT INTO projects VALUES($1,'Zeta',1,'2026-01-01T00:00:00.123456Z','private',$2,NULL,'main',1,NULL),($3,'Foreign',1,now(),'private',$4,NULL,'main',1,NULL)",[p,a.id,foreign,b.id])
  await q("INSERT INTO images VALUES($1,'Fixture','image/png','personal',$2,$2,'2026-01-01T00:00:00.123456Z',NULL)",[image,a.id])
  const projects=createProjectRepository(q),images=createImageRepository(q),blocks=createBlockRepository(q)
  assert.equal((await projects.list(a)).length,1);assert.equal((await images.list(a)).length,1);assert.deepEqual(await images.list(b),[])
  assert.equal((await projects.list(a))[0].created_at.toISOString(),'2026-01-01T00:00:00.123Z')
  await q("INSERT INTO project_revisions VALUES($1,1,'One',now(),$2),($1,2,'Two',now(),$2)",[p,a.id])
  await q("INSERT INTO block_versions VALUES($1,1,'One',now(),$2),($1,2,'Two',now(),$2)",[block,a.id])
  assert.deepEqual((await projects.revisions(p)).map(i=>i.revision),[2,1]);assert.deepEqual((await blocks.versions(block)).map(i=>i.version),[2,1])
  await q("INSERT INTO project_settings_history VALUES(9007199254740992,$1,'{}','{\"visibility\":\"first\"}',now(),$2),(9007199254740993,$1,'{}','{\"visibility\":\"second\"}',now(),$2)",[p,a.id])
  const history=await projects.settingsHistory(p);assert.deepEqual(history.map(i=>i.after.visibility),['second','first']);assert.equal(history[0]._legacy_id,undefined)
  const insertSql="INSERT INTO project_revisions VALUES($1,3,$2,now(),$3)"
  await q(insertSql,[p,'x'.repeat(legacyListBytes),a.id]);await assert.rejects(projects.revisions(p),{status:413})
  const oversized=last
  const plan=(await pool.query('EXPLAIN(ANALYZE,VERBOSE,FORMAT JSON) '+oversized.text,oversized.args)).rows[0]['QUERY PLAN'][0].Plan
  const nodes=[];function walk(node){nodes.push(node);for(const child of node.Plans||[])walk(child)}walk(plan)
  assert.ok(nodes.some(node=>node['Actual Loops']===0&&(node.Output||[]).some(output=>output.includes('jsonb_agg'))),'JSON array must not be built after a failed budget')
  await q('DELETE FROM project_revisions WHERE revision=3')
  await q("INSERT INTO project_revisions SELECT $1,i,'Fixture',now(),$2 FROM generate_series(3,1000) i",[p,a.id]);assert.equal((await projects.revisions(p)).length,1000)
  await q("INSERT INTO project_revisions VALUES($1,1001,'Fixture',now(),$2)",[p,a.id]);await assert.rejects(projects.revisions(p),{status:413})
  const listed=await boundedLegacyList(q,"SELECT 'exact' AS name,repeat('x',$1) AS summary",[legacyListBytes-5],{order:'r.name',textFields:['name','summary']});assert.equal(listed[0].summary.length,legacyListBytes-5)
  await assert.rejects(boundedLegacyList(q,"SELECT 'exact' AS name,repeat('x',$1) AS summary",[legacyListBytes-4],{order:'r.name',textFields:['name','summary']}),{status:413})
})
