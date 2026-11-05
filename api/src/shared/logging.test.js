import test from 'node:test'
import assert from 'node:assert/strict'
import { reportFailure, failureCode } from './logging.js'
import { errorHandler } from './http.js'
import { syncOne } from '../github.js'
import { pool } from '../db.js'

test('storage admission errors expose stable public codes without database diagnostics', () => {
  for (const [sqlCode, status, code] of [['PZ001',409,'storageQuotaExceeded'],['PZ002',503,'storageUnavailable']]) {
    let body
    errorHandler({ code: sqlCode, message: 'private database detail', detail: 'private database detail' }, null, { status: value => { assert.equal(value, status); return { json: value => { body = value } } } }, () => {})
    assert.equal(body.code, code)
    assert.equal(JSON.stringify(body).includes('private database detail'), false)
    assert.match(body.error, /administrador|Migra/)
  }
})

test('unexpected HTTP and GitHub errors expose only fixed codes, not credentials or response bodies',async t=>{
  const saved=console.error,logs=[];console.error=(...parts)=>logs.push(parts.join(' '));t.after(()=>{console.error=saved})
  const secret='isolated-secret-never-log',err=Object.assign(Error(secret),{detail:secret,headers:{Authorization:secret}})
  reportFailure('Test error',err)
  pool.emit('error', err)
  assert(logs.includes('Database pool error: UNEXPECTED_ERROR'))
  let body
  errorHandler(err,null,{status:status=>{assert.equal(status,500);return{json:value=>{body=value}}}},()=>{})
  assert.deepEqual(body,{error:'Error interno'})
  const previous={...process.env};Object.assign(process.env,{GITHUB_APP_ID:'1',GITHUB_INSTALLATION_ID:'1',GITHUB_PRIVATE_KEY:'test-only-key'})
  t.after(()=>{for(const key of ['GITHUB_APP_ID','GITHUB_INSTALLATION_ID','GITHUB_PRIVATE_KEY']){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]}})
  const updates=[]
  const query=async(sql,args)=>{if(/^SELECT (j\.)?\* FROM sync_jobs/.test(sql)){assert.match(sql,/NOT EXISTS\(SELECT 1 FROM projects p WHERE p\.id=j\.record_id AND p\.deleted_at IS NOT NULL\)/);return{rows:[{id:1,target_repository:'test/repo',target_branch:'main',record_id:'id',revision:1,yaml:'name: test'}]}};updates.push(args);return{rows:[]}}
  await syncOne({query,authenticate:()=>{throw err}})
  assert.equal(updates[0][1],'UNEXPECTED_ERROR')
  let count=0
  await syncOne({query,authenticate:()=>async()=>({token:secret}),request:async()=>++count===1?{ok:false,status:404}:{ok:false,status:403,text:()=>{throw Error('Must not read untrusted body '+secret)}}})
  assert.equal(updates[1][1],'GITHUB_WRITE_403')
  assert.equal(logs.join('').includes(secret),false)
  assert.equal(failureCode({code:secret}),'UNEXPECTED_ERROR')
})
