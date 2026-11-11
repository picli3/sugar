import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createProjectRepository } from '../projects/repository.js'
import { createProjectService } from '../projects/service.js'
import { initProjectPaginationDb } from '../projects/pagination.js'
import { createImageRepository } from '../images/repository.js'
import { createImageService } from '../images/service.js'
import { createBlockRepository } from '../blocks/repository.js'
import { createBlockService } from '../blocks/service.js'
import { pageInput } from './pagination.js'
const url=process.env.API_TEST_DATABASE_URL
test('metadata pages pack complete legacy values and preserve microsecond and bigint continuation', {skip:!url},async t=>{
  const schema='metadata_pages_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url})
  await admin.query('CREATE SCHEMA '+schema)
  const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema}),q=(sql,args)=>pool.query(sql,args)
  t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()})
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int,created_at timestamptz,visibility text,created_by uuid,sync_repository text,sync_branch text,settings_version int,deleted_at timestamptz)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text)')
  await initProjectPaginationDb(q)
  await q('CREATE TABLE images(id uuid PRIMARY KEY,name text,mime text,scope text,owner_id uuid,created_by uuid,created_at timestamptz,deleted_at timestamptz)')
  await q('CREATE TABLE project_revisions(project_id uuid,revision int,summary text,created_at timestamptz,author_id uuid)')
  await q('CREATE TABLE blocks(id uuid PRIMARY KEY,owner_id uuid,deleted_at timestamptz)')
  await q('CREATE TABLE block_versions(block_id uuid,version int,summary text,created_at timestamptz,author_id uuid)')
  await q('CREATE TABLE project_settings_history(id bigint PRIMARY KEY,project_id uuid,before jsonb,after jsonb,created_at timestamptz,author_id uuid)')
  const a={id:crypto.randomUUID(),role:'dev'},b={id:crypto.randomUUID(),role:'dev'},p=[],big='é'.repeat(750000),block=crypto.randomUUID()
  await q("INSERT INTO users VALUES($1,'owner@example.invalid'),($2,'other@example.invalid')",[a.id,b.id])
  for(let i=0;i<4;i++){
    p.push(crypto.randomUUID())
    await q("INSERT INTO projects VALUES($1,$2,1,'2026-01-01T00:00:00.123456Z','private',$3,NULL,'main',1,NULL)",[p[i],big,a.id])
    await q("INSERT INTO images VALUES($1,$2,'image/png','personal',$3,$3,'2026-01-01T00:00:00.123456Z',NULL)",[crypto.randomUUID(),big,a.id])
    await q("INSERT INTO project_revisions VALUES($1,$2,$3,now(),$4)",[p[0],i+1,big,a.id])
    await q("INSERT INTO block_versions VALUES($1,$2,$3,now(),$4)",[block,i+1,big,a.id])
  }
  await q('INSERT INTO blocks VALUES($1,$2,NULL)',[block,a.id])
  const projects=createProjectService({projects:createProjectRepository(q)}),images=createImageService(createImageRepository(q)),blocks=createBlockService({blocks:createBlockRepository(q)})
  let first=await projects.page(a,{limit:'30'});assert.equal(first.items.length,2);assert.ok(first.items.every(row=>row.name===big));assert.match(pageInput({cursor:first.nextCursor}).after.at,/\.123456Z$/)
  const last=await projects.page(a,{cursor:first.nextCursor});assert.equal(last.items.length,2);assert.equal(last.nextCursor,null);assert.equal(new Set([...first.items,...last.items].map(row=>row.id)).size,4)
  assert.deepEqual((await projects.page(b,{})).items,[])
  first=await images.page(a,{});assert.equal(first.items.length,2);assert.equal((await images.page(a,{cursor:first.nextCursor})).items.length,2)
  for(const [read,key] of [[query=>projects.revisionsPage(p[0],a,query),'revision'],[query=>blocks.versionsPage(block,a,query),'version']]){
    const page=await read({});assert.equal(page.items.length,2);assert.deepEqual(page.items.map(row=>row[key]),[4,3]);assert.ok(page.items.every(row=>row.summary===big))
    const next=await read({cursor:page.nextCursor});assert.deepEqual(next.items.map(row=>row[key]),[2,1]);assert.equal(next.nextCursor,null)
  }
  for(const id of ['9','10','9007199254740993'])await q('INSERT INTO project_settings_history VALUES($1,$2,$3,\'{}\',now(),$4)',[id,p[0],JSON.stringify({value:big}),a.id])
  first=await projects.settingsHistoryPage(p[0],a,{});assert.deepEqual(first.items.map(row=>row.id),['9007199254740993','10']);assert.equal(first.items[0].before.value,big)
  const older=await projects.settingsHistoryPage(p[0],a,{cursor:first.nextCursor});assert.equal(older.items[0].id,'9');assert.equal(older.nextCursor,null)
  await q("INSERT INTO project_revisions VALUES($1,5,$2,now(),$3)",[p[0],'x'.repeat(4*1024*1024+1),a.id])
  await assert.rejects(projects.revisionsPage(p[0],a,{}),{status:413})
})
