import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { readZip } from '../../test-support/zip.js'
import { createApp } from '../app.js'
import { createTransaction } from '../db.js'
import { enqueue } from '../github.js'
import { limitsConfig } from '../security/limits.js'
import { createGithubIntegration } from './integration.js'
import { createGithubClient } from './client.js'
const enabled = process.env.API_TEST_URL && process.env.API_TEST_DATABASE_URL

test('authenticated GitHub HTTP binds OAuth to sessions, owner targets and safe catalogs with provider mocks', { skip: !enabled }, async t => {
  const db = new pg.Pool({connectionString:process.env.API_TEST_DATABASE_URL}), q = (sql,args) => db.query(sql,args), transaction = createTransaction(db)
  t.after(() => db.end())
  const password='synthetic-github-http-password', hash=await bcrypt.hash(password,4), actors=[]
  for(const role of ['dev','dev','Admin','view']) {
    const id=crypto.randomUUID(), email=id+'@example.invalid'
    await q('INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)',[id,email,hash,role]); actors.push({id,email,role})
  }
  const [a,b,admin,view]=actors, env={PUBLIC_ORIGIN:'https://sugar.example.invalid',GITHUB_CLIENT_ID:'Iv1.synthetic',GITHUB_CLIENT_SECRET:'synthetic-http-client-secret',GITHUB_USER_ENCRYPTION_KEY:'17'.repeat(32),GITHUB_CONNECT_ENABLED:'true',GITHUB_APP_SLUG:'sugar-fixture'}
  let calls=0,writes=0,revokes=0
  const access='ghu_'+'a'.repeat(40), result=(body,status=200)=>new Response(body===null?null:JSON.stringify(body),{status,headers:{'content-type':'application/json'}})
  const client=createGithubClient({...env,clientId:env.GITHUB_CLIENT_ID,clientSecret:env.GITHUB_CLIENT_SECRET,origin:env.PUBLIC_ORIGIN,request:async (url,options)=>{
    calls++; const path=new URL(url).pathname
    if(path==='/login/oauth/access_token') return result({access_token:access,scope:'',token_type:'bearer'})
    if(options.method==='DELETE') {revokes++;return result(null,204)}
    assert.equal(options.headers.Authorization,'Bearer '+access)
    if(path==='/user') return result({id:111,login:'fixture-user',type:'User'})
    if(path==='/user/installations') return result({total_count:1,installations:[{id:7,account:{id:9,login:'fixture'},permissions:{contents:'write'},suspended_at:null}]})
    if(path==='/user/installations/7/repositories') return result({total_count:1,repositories:[{id:8,owner:{id:9},full_name:'fixture/repo',private:true,default_branch:'main',permissions:{push:true},archived:false,disabled:false}]})
    if(path==='/repos/fixture/repo/branches/main') return result({name:'main'})
    assert.match(path,/\/contents\/projects\//)
    if(options.method==='PUT') {writes++;return result({commit:{sha:'a'.repeat(40)}})}
    return result(null,404)
  }})
  const audits=[],integration=createGithubIntegration({q,transaction,env,client})
  const app=createApp({q,transaction,secret:'synthetic-github-http-session-secret-32-bytes',enqueue,githubEnv:env,githubClient:client,auditWriter:e=>audits.push(e),accessConfig:{...limitsConfig(),credentials:100,loginIp:100},registrationConfig:{enabled:false},recoveryConfig:{enabled:false}})
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  async function request(path,actor=a,body,headers={}) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(actor?.cookie?{cookie:actor.cookie}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})})
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer')
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}
  }
  for(const actor of actors) {const login=await request('/login',null,{email:actor.email,password});assert.equal(login.status,200);actor.cookie=login.cookie}
  assert.equal((await request('/me/github',null)).status,401)
  assert.equal((await request('/me/github/authorize',view,{currentPassword:password})).status,403)
  assert.equal((await request('/me/github/authorize',a,{currentPassword:password},{origin:'https://attacker.invalid'})).status,403)
  assert.equal((await request('/me/github/authorize',a,{currentPassword:'wrong'})).status,400)
  assert.equal((await request('/me/github/authorize',a,{currentPassword:'x'.repeat(5000)})).status,413)
  const begin=await request('/me/github/authorize',a,{currentPassword:password});assert.equal(begin.status,200)
  const auth=new URL(begin.body.authorizationUrl),state=auth.searchParams.get('state');assert.equal(auth.origin,'https://github.com');assert.equal(auth.searchParams.get('code_challenge_method'),'S256')
  assert.equal(calls,0)
  const alternate=await request('/login',null,{email:a.email,password})
  assert.equal((await request('/me/github/complete',{...a,cookie:alternate.cookie},{code:'fixture-code',state})).status,400)
  assert.equal((await request('/me/github/complete',b,{code:'fixture-code',state})).status,400)
  const complete=await request('/me/github/complete',a,{code:'fixture-code',state});assert.equal(complete.status,200)
  assert.equal((await request('/me/github/complete',a,{code:'fixture-code',state})).status,400);assert.equal(calls,2)
  const status=await request('/me/github');assert.equal(status.body.connected,true);assert.equal(status.body.installationUrl,'https://github.com/apps/sugar-fixture/installations/new')
  assert.equal(JSON.stringify(status.body).includes(access),false);assert.equal(JSON.stringify(status.body).includes('box'),false)
  assert.equal((await request('/me/github',b)).body.connected,false)
  assert.equal((await request('/me/github',view)).body.eligible,false)
  assert.equal((await request('/me/github',a)).body.eligible,true)
  assert.equal((await request('/me/github/installations',b)).status,409)
  assert.equal((await request('/me/github/installations')).body[0].id,'7')
  assert.equal((await request('/me/github/installations/7/repositories')).body[0].id,'8')
  const created=await request('/projects',a,{yaml:JSON.stringify({name:'Synthetic Github HTTP',nodes:[],edges:[]})});assert.equal(created.status,201)
  async function settings(actor,body) {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${created.body.id}/settings`,{method:'PATCH',headers:{'content-type':'application/json',cookie:actor.cookie},body:JSON.stringify(body)})
    return {status:response.status,body:await response.json()}
  }
  const input={visibility:'private',sync_repository:'fixture/repo',sync_branch:'main',sync_installation_id:'7',sync_repository_id:'8',expectedSettingsVersion:1}
  assert.equal((await settings(admin,input)).status,403);assert.equal((await settings(b,input)).status,403)
  assert.equal((await settings(a,input)).status,200)
  assert.equal((await request(`/projects/${created.body.id}/github-target`)).body.authorized,true)
  assert.equal((await request(`/projects/${created.body.id}/github-target`,b)).status,403)
  const savedGrant=(await q('SELECT id FROM github_project_grants WHERE project_id=$1',[created.body.id])).rows[0].id
  const before=calls
  assert.equal((await settings(a,{...input,expectedSettingsVersion:1})).status,409)
  assert.equal(calls,before+3) // preflight authorization cannot publish or commit a stale target.
  assert.equal((await q('SELECT id FROM github_project_grants WHERE project_id=$1',[created.body.id])).rows[0].id,savedGrant)
  const exported=await fetch(`http://127.0.0.1:${server.address().port}/api/me/export`,{headers:{cookie:a.cookie}})
  assert.equal(exported.status,200)
  const files=readZip(Buffer.from(await exported.arrayBuffer())),github=JSON.parse(files.get('github.json').toString())
  assert.equal(github.account.github_login,'fixture-user');assert.equal(github.destinations[0].repository,'fixture/repo')
  for(const secret of [access,'access_box','refresh_box','verifier_box',env.GITHUB_CLIENT_SECRET]) assert.equal(JSON.stringify(github).includes(secret),false)
  assert.equal(writes,0);await integration.worker.tick();assert.equal(writes,1)
  const disconnected=await request('/me/github/disconnect',a,{currentPassword:password});assert.equal(disconnected.body.remoteRevoked,true);assert.equal(revokes,1)
  assert.equal((await request(`/projects/${created.body.id}/github-target`)).body.authorized,false)
  assert.equal((await request(`/projects/${created.body.id}/sync/retry`,a,{})).status,409)
  const audit=JSON.stringify(audits);for(const secret of [password,access,state,'fixture-code',env.GITHUB_CLIENT_SECRET]) assert.equal(audit.includes(secret),false)
  assert.ok(audits.some(e=>e.operation==='auth.github_complete'&&e.actor===a.id&&e.result==='success'))
})
