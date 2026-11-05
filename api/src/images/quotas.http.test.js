import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'
import { defaultImageStorage } from './quotas.js'
test('only Admin configures image capacity; all roles see only their own usage',async t=>{
 const id='11111111-1111-1111-1111-111111111111',sid='22222222-2222-2222-2222-222222222222',secret='synthetic-image-storage-secret'
 let role='view',storageReads=0
 const q=async(sql,args)=>{
  if(sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme,u.display_name FROM user_sessions'))return{rows:[{id,role,email:'fixture@example.invalid',language:'en',theme:'light'}]}
  storageReads++
  if(sql.startsWith('SELECT value,version FROM image_storage_config'))return{rows:[{value:defaultImageStorage,version:1}]}
  assert.ok(sql.startsWith('SELECT count(*) AS files'));assert.ok(args[0]===id||args[0]===null)
  if(sql.includes('FROM images WHERE owner_id=$1'))return{rows:[{files:'1',bytes:'100'}]}
  return{rows:[{files:'10',bytes:'1000',user_files:'1',user_bytes:'100'}]}
 }
 const app=createApp({q,secret,transaction:()=>{throw Error('Unexpected write')},registrationConfig:{enabled:false},recoveryConfig:{enabled:false}}),server=app.listen(0,'127.0.0.1')
 await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const base=`http://127.0.0.1:${server.address().port}/api`,cookie='session='+jwt.sign({id,sid,role:'Admin'},secret,{expiresIn:60})
 assert.equal((await fetch(base+'/me/image-storage')).status,401)
 for(const method of ['GET','PUT'])assert.equal((await fetch(base+'/image-storage',{method,headers:{cookie}})).status,403)
 assert.equal(storageReads,0)
 const mine=await fetch(base+'/me/image-storage?userId=foreign',{headers:{cookie}}),body=await mine.json()
 assert.equal(mine.status,200);assert.deepEqual(body,{limits:{userFiles:1000,userBytes:100000000},usage:{files:'1',bytes:'100'}})
 assert.equal(mine.headers.get('cache-control'),'private, no-store');assert.equal(mine.headers.get('etag'),null)
 role='Admin';const admin=await fetch(base+'/image-storage',{headers:{cookie}});assert.equal(admin.status,200);assert.deepEqual((await admin.json()).usage,{files:'10',bytes:'1000'})
 const invalid=await fetch(base+'/image-storage',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({...defaultImageStorage,userFiles:'0',expectedVersion:1})});assert.equal(invalid.status,400)
})
