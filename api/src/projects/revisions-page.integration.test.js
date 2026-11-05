import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createProjectRepository } from './repository.js'
import { createProjectService } from './service.js'
const url = process.env.API_TEST_DATABASE_URL
test('revision metadata pages enforce live project access, stable integer boundaries and metadata-only reads', { skip: !url }, async t => {
  const schema = 'revisions_page_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), statements = [], q = (sql,args) => { statements.push(sql); return pool.query(sql,args) }
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,created_by uuid,visibility text,deleted_at timestamptz,yaml text)')
  await q('CREATE TABLE project_members(project_id uuid,user_id uuid,role text,PRIMARY KEY(project_id,user_id))')
  await q('CREATE TABLE project_revisions(project_id uuid,revision int,summary text,created_at timestamptz DEFAULT now(),author_id uuid,yaml text,PRIMARY KEY(project_id,revision))')
  const a={id:crypto.randomUUID(),role:'dev'}, b={id:crypto.randomUUID(),role:'view'}, p=crypto.randomUUID(), other=crypto.randomUUID()
  await q("INSERT INTO users VALUES($1,'first@example.invalid'),($2,'second@example.invalid')", [a.id,b.id])
  await q("INSERT INTO projects VALUES($1,$2,'private',NULL,'private diagram'),($3,$4,'private',NULL,'other private diagram')",[p,a.id,other,b.id])
  await q("INSERT INTO project_revisions SELECT $1,i,'Fixture '||i,now(),$2,'private revision bytes' FROM generate_series(1,67) i",[p,a.id])
  await q("INSERT INTO project_revisions VALUES($1,500,'Other project',now(),$2,'other revision bytes')",[other,b.id])
  const service=createProjectService({projects:createProjectRepository(q)}), seen=[]
  let page=await service.revisionsPage(p,a,{limit:'30'})
  assert.equal(page.items.length,30); assert.equal(page.nextCursor,'38')
  await q("INSERT INTO project_revisions VALUES($1,68,'Later insert',now(),$2,'later bytes')",[p,a.id])
  while(true){seen.push(...page.items.map(i=>i.revision));assert.ok(page.items.every(i=>i.yaml===undefined));if(!page.nextCursor)break;page=await service.revisionsPage(p,a,{limit:'30',cursor:page.nextCursor})}
  assert.deepEqual(seen,Array.from({length:67},(_,i)=>67-i))
  assert.equal((await service.revisionsPage(p,a,{})).items[0].revision,68)
  statements.length=0
  await assert.rejects(service.revisionsPage(p,b,{cursor:'2'}),{status:403})
  assert.equal(statements.some(sql=>sql.includes('FROM project_revisions')),false)
  await q("INSERT INTO project_members VALUES($1,$2,'reader')",[p,b.id])
  statements.length=0
  assert.equal((await service.revisionsPage(p,b,{limit:'1'})).items[0].revision,68)
  assert.ok(statements.every(sql=>!sql.includes('p.yaml')&&!sql.includes('r.yaml')))
  await q('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[p,b.id])
  await assert.rejects(service.revisionsPage(p,b,{cursor:'38'}),{status:403})
  await assert.rejects(service.revisionsPage(other,a,{cursor:'38'}),{status:403})
  await q("UPDATE projects SET visibility='public' WHERE id=$1",[p])
  assert.equal((await service.revisionsPage(p,b,{limit:'1',cursor:'2'})).items[0].revision,1)
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1',[p])
  await assert.rejects(service.revisionsPage(p,a,{}),{status:404})
})
