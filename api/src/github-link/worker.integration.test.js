import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { createTransaction } from '../db.js'
import { initSessionDb, createSessionRepository } from '../auth/sessions.js'
import { initGithubLinkDb } from './migration.js'
import { initGithubTargetsDb } from './targets.js'
import { createGithubIntegration } from './integration.js'
import { enqueue, createProjectSyncService } from '../github.js'
import { githubError } from './protocol.js'
const url = process.env.API_TEST_DATABASE_URL

test('scoped GitHub queue binds authorizations, leases accounts across replicas, preserves legacy jobs and rolls back grants', { skip: !url }, async t => {
  const schema = 'github_worker_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args), transaction = createTransaction(db)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,email text,role text,active boolean DEFAULT true,language text DEFAULT 'es',theme text DEFAULT 'light',password_hash text)`)
  await q('CREATE TABLE settings(key text PRIMARY KEY,value jsonb NOT NULL)')
  await initSessionDb(q); await initGithubLinkDb(q)
  await q(`CREATE TABLE projects(id uuid PRIMARY KEY,created_by uuid,sync_repository text,sync_branch text,deleted_at timestamptz)`)
  await q(`CREATE TABLE sync_jobs(id bigserial PRIMARY KEY,kind text,record_id uuid,revision int,yaml text,target_repository text,target_branch text,status text DEFAULT 'pending',attempts int DEFAULT 0,error text,next_attempt_at timestamptz DEFAULT now(),commit_sha text,created_at timestamptz DEFAULT now())`)
  const password = 'synthetic-worker-password', hash = await bcrypt.hash(password, 4), sessions = createSessionRepository(q, transaction)
  const actors = []
  for (const role of ['dev', 'dev', 'Admin']) {
    const id = crypto.randomUUID(), sid = crypto.randomUUID()
    await q('INSERT INTO users(id,email,role,password_hash) VALUES($1,$2,$3,$4)', [id,id+'@example.invalid',role,hash])
    await sessions.create(sid,id,hash,new Date(Date.now()+3600000)); actors.push({id,role,sid})
  }
  const [a,b,admin] = actors, projectId = crypto.randomUUID()
  await q('INSERT INTO projects VALUES($1,$2,$3,$4,NULL)', [projectId,a.id,'fixture/repo','design'])
  await q("INSERT INTO sync_jobs(kind,record_id,revision,yaml,target_repository,target_branch) VALUES('project',$1,1,'legacy','fixture/repo','design')", [projectId])
  await initGithubTargetsDb(q); await initGithubTargetsDb(q)
  assert.equal((await q('SELECT status FROM sync_jobs')).rows[0].status,'blocked')
  await q("UPDATE sync_jobs SET status='pending'")
  assert.equal((await q('SELECT status FROM sync_jobs')).rows[0].status,'blocked')
  const env = { PUBLIC_ORIGIN: 'https://sugar.example.invalid', GITHUB_CLIENT_ID: 'Iv1.synthetic', GITHUB_CLIENT_SECRET: 'synthetic-secret', GITHUB_USER_ENCRYPTION_KEY: '11'.repeat(32), GITHUB_CONNECT_ENABLED: 'true' }
  const tokens = new Map(), writes = []; let writeHook, error, authorizeHook
  const client = {
    exchange: async ({ code }) => { const token = 'ghu_' + crypto.randomBytes(20).toString('hex'); tokens.set(token,code); return {accessToken:token,refreshToken:null,expiresAt:null,refreshExpiresAt:null} },
    identity: async token => ({id:tokens.get(token),login:'fixture-'+tokens.get(token)}), revoke: async () => {},
    authorize: async (token,target) => { assert.equal(tokens.get(token),'111'); if (authorizeHook) await authorizeHook(); return {...target,private:true} },
    writeRevision: async (token,target,payload) => { assert.equal(tokens.get(token),'111'); writes.push({target,payload}); if(writeHook) await writeHook(); if(error) throw error; return {commitSha:'a'.repeat(40)} },
  }
  const create = () => createGithubIntegration({q,transaction,env,client}), integration = create()
  for (const [actor,code] of [[a,'111'],[b,'222']]) {
    const state = new URL((await integration.links.begin(actor,actor.sid,{currentPassword:password})).authorizationUrl).searchParams.get('state')
    await integration.links.complete(actor,actor.sid,{code,state})
  }
  const project = (await q('SELECT * FROM projects')).rows[0], input = {sync_installation_id:'7',sync_repository_id:'8'}
  await assert.rejects(integration.targets.prepare(project,b,b.sid,input,'fixture/repo','design'),{code:'GITHUB_OWNER_REQUIRED'})
  await assert.rejects(integration.targets.prepare(project,admin,admin.sid,input,'fixture/repo','design'),{code:'GITHUB_OWNER_REQUIRED'})
  const prepare = () => integration.targets.prepare(project,a,a.sid,input,'fixture/repo','design')
  let grant = await prepare()
  await assert.rejects(transaction(async tx => { await integration.targets.save(tx,projectId,grant); await enqueue('project',projectId,2,'name: rollback',tx,{repository:'fixture/repo',branch:'design'}); throw Error('rollback') }))
  assert.equal(await integration.targets.state(projectId),null); assert.equal((await q('SELECT * FROM sync_jobs')).rowCount,1)
  await transaction(async tx => { await integration.targets.save(tx,projectId,grant); await enqueue('project',projectId,2,'name: synthetic',tx,{repository:'fixture/repo',branch:'design'}) })
  const job = async revision => (await q('SELECT * FROM sync_jobs WHERE revision=$1',[revision])).rows[0]
  assert.equal((await job(2)).status,'pending'); assert.equal((await job(2)).github_connection_id,grant.linkId)
  let release, entered; const held = new Promise(resolve => {release=resolve}), ready = new Promise(resolve => {entered=resolve})
  writeHook = async () => { entered(); await held }
  const one = integration.worker.tick(); await ready
  const two = create().worker.tick()
  release(); await Promise.all([one,two]); writeHook = undefined
  assert.equal(writes.length,1); assert.equal((await job(2)).status,'synced')
  assert.deepEqual(writes[0].target,{installationId:'7',repositoryId:'8',repository:'fixture/repo',branch:'design',allowPublic:false})
  // A changed grant cannot re-arm an older capability, even at the same human target.
  await enqueue('project',projectId,3,'name: old grant',q,{repository:'fixture/repo',branch:'design'})
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1',[projectId]);await integration.worker.tick();assert.equal((await job(3)).status,'pending');assert.equal(writes.length,1)
  await q('UPDATE projects SET deleted_at=NULL WHERE id=$1',[projectId])
  grant = await prepare(); await transaction(tx => integration.targets.save(tx,projectId,grant))
  await integration.worker.tick(); assert.equal((await job(3)).status,'blocked'); assert.equal(writes.length,1)
  const service = createProjectSyncService({query:q,projects:{get:async (_id,user,options)=>{assert.equal(options.ownerOnly,true);return project}},targets:integration.targets,synchronize:async()=>{}})
  await assert.rejects(service.retry(projectId,b),{status:403}); await assert.rejects(service.retry(projectId,admin),{status:403})
  await service.retry(projectId,a); assert.equal((await job(3)).status,'blocked')
  // Provider errors use fixed codes, persist attempts, and do not erase another user's link.
  await enqueue('project',projectId,4,'name: retry',q,{repository:'fixture/repo',branch:'design'})
  error = githubError('GITHUB_TIMEOUT',504); await integration.worker.tick()
  assert.equal((await job(4)).status,'pending'); assert.equal((await job(4)).attempts,1); assert.equal((await job(4)).error,'GITHUB_TIMEOUT')
  await q("UPDATE sync_jobs SET next_attempt_at=now() WHERE revision=4"); error=githubError('GITHUB_USER_REVOKED',409); await integration.worker.tick(); error=undefined
  assert.equal((await job(4)).status,'blocked'); assert.equal((await integration.targets.state(projectId)).authorized,false)
  assert.equal((await integration.links.status(b)).connected,true)
  await enqueue('project',projectId,5,'name: after revoke',q,{repository:'fixture/repo',branch:'design'})
  assert.equal((await job(5)).status,'blocked'); const before=writes.length; await integration.worker.tick(); assert.equal(writes.length,before)
  assert.equal((await service.target(projectId,b)).target,null)
})
