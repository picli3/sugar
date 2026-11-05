import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'
import { defaultDocumentStorage } from './config.js'
test('document capacity is Admin-only and personal summaries cannot select another owner',async t=>{
  const id='11111111-1111-1111-1111-111111111111',sid='22222222-2222-2222-2222-222222222222',secret='synthetic-document-storage-secret'
  let role='view',reads=0
  const q=async(sql,args)=>{
    if(sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme,u.display_name FROM user_sessions'))return{rows:[{id,role,email:'fixture@example.invalid',language:'en',theme:'light'}]}
    reads++
    if(sql.startsWith('SELECT value,version FROM document_storage_config'))return{rows:[{value:defaultDocumentStorage,version:1}]}
    assert.ok(sql.startsWith('SELECT count(*) FILTER'));assert.ok(!args.length||args[0]===id)
    return{rows:[{projects:'1',blocks:'2',revisions:'3',bytes:'100'}]}
  }
  const app=createApp({q,secret,transaction:()=>{throw Error('Unexpected write')},registrationConfig:{enabled:false},recoveryConfig:{enabled:false}}),server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}/api`,cookie='session='+jwt.sign({id,sid,role:'Admin'},secret,{expiresIn:60})
  assert.equal((await fetch(base+'/me/document-storage')).status,401)
  for(const method of ['GET','PUT'])assert.equal((await fetch(base+'/document-storage',{method,headers:{cookie}})).status,403)
  assert.equal(reads,0)
  const response=await fetch(base+'/me/document-storage?userId=foreign',{headers:{cookie}}),body=await response.json()
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(body.limits.platformBytes,undefined);assert.equal(body.usage.bytes,'100')
  role='Admin';assert.equal((await fetch(base+'/document-storage',{headers:{cookie}})).status,200)
  const invalid=await fetch(base+'/document-storage',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({...defaultDocumentStorage,userBlocks:'0',expectedVersion:1})});assert.equal(invalid.status,400)
})
