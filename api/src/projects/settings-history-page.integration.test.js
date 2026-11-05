import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createProjectRepository } from './repository.js'
import { createProjectService } from './service.js'
const url=process.env.API_TEST_DATABASE_URL
test('settings history pages preserve bigint ids, isolate projects and recheck access without loading YAML', {skip:!url}, async t=>{
  const schema='settings_history_page_'+crypto.randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url})
  await admin.query('CREATE SCHEMA '+schema)
  const pool=new pg.Pool({connectionString:url,options:'-c search_path='+schema}),statements=[],q=(sql,args)=>{statements.push(sql);return pool.query(sql,args)}
  t.after(async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()})
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,created_by uuid,visibility text,deleted_at timestamptz,yaml text)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text,PRIMARY KEY(project_id,user_id))')
  await q('CREATE TABLE project_settings_history(id bigint PRIMARY KEY,project_id uuid,author_id uuid,before jsonb,after jsonb,created_at timestamptz)')
  await q('CREATE INDEX project_settings_history_page ON project_settings_history(project_id,id DESC)')
  const a={id:crypto.randomUUID(),role:'dev'},b={id:crypto.randomUUID(),role:'view'},p=crypto.randomUUID(),other=crypto.randomUUID(),base=9007199254740990n
  await q("INSERT INTO users VALUES($1,'first@example.invalid'),($2,'second@example.invalid')",[a.id,b.id])
  await q("INSERT INTO projects VALUES($1,$2,'private',NULL,'private YAML'),($3,$4,'private',NULL,'other YAML')",[p,a.id,other,b.id])
  await q(`INSERT INTO project_settings_history SELECT $1::bigint+i,$2,$3,'{"visibility":"private"}','{"visibility":"public"}','2026-01-01 00:00:00+00' FROM generate_series(1,67) i`,[String(base),p,a.id])
  await q(`INSERT INTO project_settings_history VALUES(9223372036854775807,$1,$2,'{}','{}',now())`,[other,b.id])
  const service=createProjectService({projects:createProjectRepository(q)}),seen=[]
  let page=await service.settingsHistoryPage(p,a,{limit:'30'})
  assert.equal(page.nextCursor,String(base+38n));assert.equal(typeof page.items[0].id,'string')
  await q("INSERT INTO project_settings_history VALUES($1,$2,$3,'{}','{}',now())",[String(base+68n),p,a.id])
  while(true){seen.push(...page.items.map(i=>i.id));if(!page.nextCursor)break;page=await service.settingsHistoryPage(p,a,{limit:'30',cursor:page.nextCursor})}
  assert.deepEqual(seen,Array.from({length:67},(_,i)=>String(base+BigInt(67-i))))
  assert.equal((await service.settingsHistoryPage(p,a,{})).items[0].id,String(base+68n))
  statements.length=0;await assert.rejects(service.settingsHistoryPage(p,b,{cursor:String(base+38n)}),{status:403});assert.ok(!statements.some(s=>s.includes('FROM project_settings_history')))
  await q("INSERT INTO project_members VALUES($1,$2,'reader')",[p,b.id]);assert.equal((await service.settingsHistoryPage(p,b,{limit:'1'})).items.length,1)
  await q('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[p,b.id]);await assert.rejects(service.settingsHistoryPage(p,b,{}),{status:403})
  await assert.rejects(service.settingsHistoryPage(other,a,{cursor:'9223372036854775807'}),{status:403})
  assert.equal((await service.settingsHistoryPage(other,{...a,role:'Admin'},{})).items[0].id,'9223372036854775807')
  await q("UPDATE projects SET visibility='public' WHERE id=$1",[p]);assert.equal((await service.settingsHistoryPage(p,b,{})).items.length,30)
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1',[p]);await assert.rejects(service.settingsHistoryPage(p,a,{}),{status:404})
  assert.ok(statements.every(sql=>!sql.includes('p.yaml')))
})
