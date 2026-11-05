import test from 'node:test'
import assert from 'node:assert/strict'
import { reportFailure, failureCode } from './logging.js'
import { errorHandler } from './http.js'
import { createGithubSynchronizer } from '../github-link/worker.js'
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
  const updates=[]
  const query=async(sql,args)=>{if(sql.startsWith('SELECT * FROM sync_jobs'))return{rows:[{id:1,github_owner_id:'synthetic-owner',github_connection_id:'synthetic-link'}]};updates.push(args);return{rows:[]}}
  for (const error of [err,Object.assign(Error(secret),{code:'GITHUB_ACCESS_DENIED'})]) {
    const worker=createGithubSynchronizer({q:query,config:{available:true},links:{withCredential:async()=>{throw error}}})
    await syncOne({integration:{worker}})
  }
  assert.equal(updates[0][1],'UNEXPECTED_ERROR')
  assert.equal(updates[1][1],'GITHUB_ACCESS_DENIED')
  assert.equal(logs.join('').includes(secret),false)
  assert.equal(failureCode({code:secret}),'UNEXPECTED_ERROR')
})
