import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'
import { createCategoryReadService } from './service.js'
test('category context rejects oversized/malformed input before queries and requires a session',async t=>{
  const fail=()=>{throw Error('Unexpected category SQL')},service=createCategoryReadService({resolve:fail,page:fail}),user={id:'fixture',role:'view'}
  for(const input of [null,{}, {slugs:Array(65).fill('fixture')},{slugs:['a'.repeat(257)]},{slugs:['*']},{slugs:['fixture'],userId:'other'},{slugs:[1]}])await assert.rejects(service.resolve(user,input),{status:400})
  assert.deepEqual(await service.resolve(user,{slugs:[]}),[])
  const id='11111111-1111-1111-1111-111111111111',sid='22222222-2222-2222-2222-222222222222',secret='synthetic-category-context-secret'
  const q=async text=>{assert.ok(text.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme FROM user_sessions'));return{rows:[{id,role:'view',email:'fixture@example.invalid',theme:'light',language:'en'}]}}
  const app=createApp({q,secret,registrationConfig:{enabled:false},recoveryConfig:{enabled:false}}),server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}/api`,cookie='session='+jwt.sign({id,sid},secret,{expiresIn:60})
  assert.equal((await fetch(base+'/categories/page')).status,401)
  assert.equal((await fetch(base+'/categories/resolve',{method:'POST',headers:{'content-type':'application/json'},body:'{"slugs":[]}'})).status,401)
  const response=await fetch(base+'/categories/resolve',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"slugs":[]}'});assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);assert.equal(response.headers.get('cache-control'),'private, no-store')
  for(const suffix of ['?limit=101','?cursor=invalid','?scope=all'])assert.equal((await fetch(base+'/categories/page'+suffix,{headers:{cookie}})).status,400)
})
