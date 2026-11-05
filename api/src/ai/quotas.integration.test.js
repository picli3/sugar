import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import express from 'express'
import { createTransaction } from '../db.js'
import { initAiDb, registerAi } from '../ai.js'
import { createAiQuotas, defaultQuotas } from './quotas.js'
import { errorHandler } from '../shared/http.js'
const databaseUrl = process.env.API_TEST_DATABASE_URL

test('AI budgets, durable claims and replicas share atomic PostgreSQL reservations', { skip: !databaseUrl }, async t => {
  const root = new pg.Pool({ connectionString: databaseUrl }), schema = 'quota_' + crypto.randomUUID().replaceAll('-', '')
  await root.query(`CREATE SCHEMA ${schema}`)
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }), second = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  t.after(async () => { await pool.end(); await second.end(); await root.query(`DROP SCHEMA ${schema} CASCADE`); await root.end() })
  const q = (sql, args) => pool.query(sql, args), transaction = createTransaction(pool), quotas = createAiQuotas({ q, transaction }), replica = createAiQuotas({ q: (sql, args) => second.query(sql, args), transaction: createTransaction(second) })
  const a = crypto.randomUUID(), b = crypto.randomUUID(), p = crypto.randomUUID()
  await q('CREATE TABLE users(id uuid PRIMARY KEY,display_name text,email text)'); await q('INSERT INTO users VALUES($1,$2),($3,$4)', [a,'quota-a@local',b,'quota-b@local'])
  await q('CREATE TABLE projects(id uuid PRIMARY KEY)'); await q('INSERT INTO projects VALUES($1)', [p])
  await q('CREATE TABLE settings(key text PRIMARY KEY,value jsonb)')
  await initAiDb(q)
  const configure = async values => { const old = await quotas.config(); return quotas.configure({ ...defaultQuotas, ...values, expectedVersion: old.version }) }
  const reset = async values => { await q('DELETE FROM ai_calls'); await q('DELETE FROM project_analyses'); await configure(values) }
  const reserve = (service, user = a, key = crypto.randomUUID(), tokens = 1000, hash = 'payload') => service.reserve(user, key, hash, tokens, p)
  await t.test('legacy analysis usage is imported once without changing saved analysis content', async () => {
    const id = crypto.randomUUID(), key = crypto.randomUUID()
    await q(`INSERT INTO project_analyses(id,project_id,author_id,request_id,snapshot,snapshot_hash,base_revision,action,focus,language,provider,model,response,usage) VALUES($1,$2,$3,$4,'{}','legacy',1,'analyze','','es','deepseek','deepseek-flash','Legacy response','{"total_tokens":42}')`, [id,p,a,key])
    await initAiDb(q); await initAiDb(q)
    const rows = (await q('SELECT * FROM ai_calls')).rows; assert.equal(rows.length, 1); assert.equal(Number(rows[0].charged_tokens), 42)
    assert.equal((await q('SELECT response FROM project_analyses WHERE id=$1', [id])).rows[0].response, 'Legacy response')
  })
  await t.test('user and platform request limits account for success, failures and independent accounts', async () => {
    await reset({ userRequests: 2, globalRequests: 3 })
    const first = await reserve(quotas); await quotas.settle(first.id, { total_tokens: 100 })
    const next = await reserve(quotas); await quotas.abandon(next.id)
    await assert.rejects(reserve(replica), /aiUserQuota/)
    const another = await reserve(replica,b); await replica.abandon(another.id)
    await assert.rejects(reserve(quotas,crypto.randomUUID()), /aiGlobalQuota/)
    const usage = await quotas.summary(a); assert.equal(usage.user.requests, 2); assert.equal(usage.user.tokens, 1100); assert.equal(usage.platform.requests, 3)
  })
  await t.test('token reservations and unknown usage prevent calls that exceed a budget', async () => {
    await reset({ userTokens: 1000, globalTokens: 1500 })
    await assert.rejects(reserve(quotas,a,crypto.randomUUID(),1001), /aiUserQuota/)
    const first = await reserve(quotas); await quotas.settle(first.id, null)
    await assert.rejects(reserve(replica), /aiUserQuota/)
    await assert.rejects(reserve(replica,b), /aiGlobalQuota/)
    assert.equal((await quotas.summary(a)).user.tokens,1000)
  })
  await t.test('two replicas cannot overspend the last platform slot or duplicate a request', async () => {
    await reset({ globalRequests: 1, maxConcurrent: 1 })
    const key = crypto.randomUUID()
    const results = await Promise.allSettled([reserve(quotas,a,key), reserve(replica,a,key)])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.match(results.find(r => r.status === 'rejected').reason.message, /aiInProgress/)
    await assert.rejects(reserve(replica,b), /aiGlobalBusy/)
    const id = results.find(r => r.status === 'fulfilled').value.id
    await quotas.settle(id,{ total_tokens: 5 })
    assert.equal((await reserve(replica,a,key)).replay, true)
    await assert.rejects(reserve(replica,a,key,1000,'changed'), /aiInvalidRequest/)
    await assert.rejects(reserve(replica,b), /aiGlobalQuota/)
  })
  await t.test('crashes retain their debit and request identity; stale slots release without retry', async () => {
    await reset({ maxConcurrent: 1 })
    const key = crypto.randomUUID(), claim = await reserve(quotas,a,key)
    await q("UPDATE ai_calls SET created_at=now()-interval '6 minutes' WHERE id=$1",[claim.id])
    const other = await reserve(replica,b)
    assert.equal((await q('SELECT status FROM ai_calls WHERE id=$1',[claim.id])).rows[0].status,'uncertain')
    await assert.rejects(reserve(quotas,a,key), /aiRequestUsed/)
    assert.equal(Number((await q('SELECT charged_tokens FROM ai_calls WHERE id=$1',[claim.id])).rows[0].charged_tokens),1000)
    await replica.abandon(other.id)
  })
  await t.test('period changes count existing charges in range and expiration opens the next window', async () => {
    await reset({ periodHours: 1, userRequests: 1 })
    const claim = await reserve(quotas); await quotas.abandon(claim.id)
    await assert.rejects(reserve(quotas), /aiUserQuota/)
    await q("UPDATE ai_calls SET created_at=now()-interval '2 hours' WHERE id=$1",[claim.id])
    const next = await reserve(replica); await replica.abandon(next.id)
    await configure({ periodHours: 24, userRequests: 1 })
    await assert.rejects(reserve(quotas), /aiUserQuota/)
  })
  await t.test('saved analysis and settled reservation roll back together; configuration uses compare-and-swap', async () => {
    await reset({})
    const claim = await reserve(quotas)
    await assert.rejects(quotas.settle(claim.id, { total_tokens: 1 }, async tx => { await tx("UPDATE ai_calls SET charged_tokens=1 WHERE id=$1",[claim.id]); throw Error('Injected save failure') }), /Injected save failure/)
    assert.equal(Number((await q('SELECT charged_tokens FROM ai_calls WHERE id=$1',[claim.id])).rows[0].charged_tokens),1000)
    await quotas.abandon(claim.id)
    const old = await quotas.config(); await configure({ userRequests: 0 })
    await assert.rejects(quotas.configure({ ...old, expectedVersion: old.version }), /aiQuotaConflict/)
    await assert.rejects(reserve(replica), /aiUserQuota/)
  })
  await t.test('HTTP across replicas saves one result, charges test calls and retains failed reservations', async () => {
    await reset({ maxConcurrent: 1 })
    await q("INSERT INTO settings VALUES('ai',$1::jsonb)", [JSON.stringify({ enabled:true,model:'deepseek-flash',token:{test:true} })])
    let calls = 0, unblock, entered
    let signal = new Promise(resolve => { entered = resolve })
    const provider = async (_config,messages) => { calls++; const data = messages.length>1 ? JSON.parse(messages[1].content) : {}; if (data.focus==='fail') throw Object.assign(Error('aiTimeout'),{status:504}); if (data.focus==='pause') { entered(); await new Promise(resolve => { unblock=resolve }) } return { response:'Mocked result',usage:{total_tokens:30} } }
    const createServer = async quota => {
      const app=express(); app.use(express.json()); app.use((req,_res,next)=>{req.user={id:req.get('x-user')||a,role:req.get('x-role')||'Admin',language:'es'};next()})
      const admin=req=>{if(req.user.role!=='Admin')throw Object.assign(Error('denied'),{status:403})}
      registerAi(app,{q,quota,callProvider:provider,requireAdmin:admin,requireEdit:req=>{if(req.user.role==='view')throw Object.assign(Error('denied'),{status:403})},requireProject:async()=>({id:p,revision:1})})
      app.use(errorHandler); const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
      return async(path,{method='GET',body,role='Admin',user=a}={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api`+path,{method,headers:{'content-type':'application/json','x-role':role,'x-user':user},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json(),headers:r.headers}}
    }
    const one=await createServer(quotas),two=await createServer(replica)
    assert.equal((await one('/ai/quotas',{role:'dev'})).status,403)
    assert.equal((await one('/ai/quotas',{method:'PUT',role:'dev',body:{}})).status,403)
    const snapshot={name:'Quota test',nodes:[{id:'n',position:{x:0,y:0},block:{name:'B',function:'Test',ports:[{id:'p',label:'P',protocol:'POWER',direction:'in'}]}}],edges:[]}
    const body={snapshot,action:'analyze',focus:'pause',language:'es',baseRevision:1,requestId:crypto.randomUUID()}, path=`/projects/${p}/analyses`
    const pending=one(path,{method:'POST',body}); await signal
    assert.equal((await two(path,{method:'POST',body})).status,409)
    assert.equal((await two(path,{method:'POST',user:b,body:{...body,requestId:crypto.randomUUID()}})).status,429)
    assert.equal(calls,1); unblock(); const saved=await pending; assert.equal(saved.status,201)
    assert.equal((await two(path,{method:'POST',body})).body.id,saved.body.id); assert.equal(calls,1)
    const failed={...body,focus:'fail',requestId:crypto.randomUUID()}
    assert.equal((await one(path,{method:'POST',body:failed})).status,504)
    assert.equal((await two(path,{method:'POST',body:failed})).status,409); assert.equal(calls,2)
    assert.equal((await one('/ai/test',{method:'POST'})).status,400); assert.equal(calls,2)
    const key=crypto.randomUUID()
    assert.equal((await one('/ai/test',{method:'POST',body:{requestId:key}})).status,200)
    assert.equal((await two('/ai/test',{method:'POST',body:{requestId:key}})).status,200); assert.equal(calls,3)
    const usage=await one('/ai/usage'); assert.equal(usage.body.user.requests,3); assert.equal(usage.headers.get('cache-control'),'private, no-store')
    assert.equal(JSON.stringify(usage.body).includes('tokenConfigured'),false)
    await configure({ userTokens: 0 })
    assert.equal((await one(path,{method:'POST',body:{...body,requestId:crypto.randomUUID()}})).status,429); assert.equal(calls,3)
  })
})
