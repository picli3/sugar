import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createCategoryRepository } from './repository.js'
import { createCategoryReadService } from './service.js'
import { initCategoryPaginationDb } from './pagination.js'
import { listCategories,projectCategoryIcons } from '../categories.js'
import { createProjectRepository } from '../projects/repository.js'
import { createProjectService } from '../projects/service.js'
const url=process.env.API_TEST_DATABASE_URL
test('category pages and bounded context respect owners/parents, while project icons require current project access', {skip:!url},async t=>{
  const schema='category_pages_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url})
  await admin.query('CREATE SCHEMA '+schema)
  const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema}),sql=[],q=(text,args)=>{sql.push(text);return pool.query(text,args)}
  t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()})
  await q('CREATE TABLE block_categories(id uuid PRIMARY KEY,slug text UNIQUE,name text,parent_id uuid,icon text,deleted_at timestamptz,owner_id uuid)')
  await initCategoryPaginationDb(q);await initCategoryPaginationDb(q)
  const a={id:crypto.randomUUID(),role:'dev'},b={id:crypto.randomUUID(),role:'view'},c={id:crypto.randomUUID(),role:'view'},id=i=>'00000000-0000-0000-0000-'+String(i).padStart(12,'0')
  const insert=(i,owner,parent=null,icon='cube',deleted=null)=>q('INSERT INTO block_categories VALUES($1,$2,$3,$4,$5,$6,$7)',[id(i),'cat-'+i,'Fixture '+i,parent,icon,deleted,owner])
  await insert(90,a.id,null,'power');await insert(91,null,null,'sensor');await insert(93,b.id,null,'cpu')
  await insert(1,a.id,id(90),null);await insert(2,null,id(91),null);await insert(3,b.id,id(93),'battery');await insert(4,a.id,id(93))
  for(let i=10;i<80;i++)await insert(i,a.id)
  await insert(95,a.id,null,'clock',new Date())
  const service=createCategoryReadService(createCategoryRepository(q)),seen=[];let cursor
  do{const page=await service.page(a,{limit:'7',...(cursor?{cursor}:{})});assert.ok(page.items.length<=7);seen.push(...page.items.map(row=>row.id));cursor=page.nextCursor}while(cursor)
  assert.equal(new Set(seen).size,seen.length);assert.ok(!seen.includes(id(3))&&!seen.includes(id(93))&&!seen.includes(id(95)))
  assert.ok(seen.includes(id(1))&&seen.includes(id(2)))
  const context=await service.resolve(a,{slugs:['cat-1','cat-2','cat-3','cat-4','cat-95','unknown']})
  assert.deepEqual(context.map(row=>row.id).sort(),[1,2,4,90,91,95].map(id).sort());assert.equal(context.find(row=>row.id===id(95)).permissions.canEdit,false)
  assert.equal(context.find(row=>row.id===id(2)).permissions.canEdit,false)
  assert.equal((await service.resolve(b,{slugs:['cat-1','cat-3']})).every(row=>row.owner_id===b.id),true)
  const all=await service.resolve({...a,role:'Admin'},{slugs:['cat-3']});assert.deepEqual(all.map(row=>row.id).sort(),[3,93].map(id).sort())
  const first=await service.page(a,{limit:'1'});await q('UPDATE block_categories SET owner_id=$2 WHERE id=$1',[id(4),b.id])
  assert.ok((await service.page(a,{cursor:first.nextCursor})).items.every(row=>row.id!==id(4)))
  assert.deepEqual(await service.resolve(a,{slugs:['cat-4']}),[])
  await q('CREATE TABLE users(id uuid PRIMARY KEY,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,revision int,yaml text,visibility text,created_by uuid,sync_repository text,sync_branch text,settings_version int,created_at timestamptz,deleted_at timestamptz)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text)')
  const p=crypto.randomUUID();await q("INSERT INTO projects VALUES($1,'Fixture',7,$2,'private',$3,NULL,'main',1,now(),NULL)",[p,'nodes:\n  - block:\n      category: cat-93\n      subcategory: cat-3\n',a.id])
  const projects=createProjectService({projects:createProjectRepository(q),categoryIcons:yaml=>projectCategoryIcons(yaml,q)})
  assert.deepEqual(await projects.icons(p,a),{'cat-93':'cpu','cat-3':'battery'})
  await assert.rejects(projects.icons(p,a,{baseRevision:'6'}),{status:409})
  await assert.rejects(projects.icons(p,a,{baseRevision:'07'}),{status:400})
  sql.length=0;await assert.rejects(projects.icons(p,c),{status:403});assert.equal(sql.some(text=>text.includes('slug=ANY')),false)
  await q("INSERT INTO project_members VALUES($1,$2,'reader')",[p,b.id]);assert.equal((await projects.icons(p,b))['cat-93'],'cpu')
  await q("UPDATE block_categories SET icon='power' WHERE id=$1",[id(93)]);assert.equal((await projects.icons(p,b))['cat-93'],'power');assert.equal((await q('SELECT revision FROM projects')).rows[0].revision,7)
  await q('DELETE FROM project_members WHERE user_id=$1',[b.id]);await assert.rejects(projects.icons(p,b),{status:403})
  await q('UPDATE projects SET deleted_at=now()');await assert.rejects(projects.icons(p,a),{status:404})
  await q("INSERT INTO block_categories SELECT md5('bulk'||i)::uuid,'bulk-'||i,'Bulk',NULL,'cube',NULL,$1 FROM generate_series(1,1001) i",[b.id])
  await assert.rejects(listCategories(q,{...a,role:'Admin'}),{status:413});assert.ok((await listCategories(q,a)).length<1000)
})
