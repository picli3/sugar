import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'
test('bounded legacy library rejects partial arrays while pages keep whole records and a continuation',async t=>{
  const id='11111111-1111-1111-1111-111111111111',sid='22222222-2222-2222-2222-222222222222',secret='synthetic-library-byte-budget-secret'
  let more=false
  const q=async(sql,args)=>{
    if(sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme,u.display_name FROM user_sessions'))return{rows:[{id,role:'dev',email:'fixture@example.invalid',language:'en',theme:'light'}]}
    assert.ok(sql.startsWith('WITH candidates AS'));assert.ok(args.includes(id))
    return{rows:[{id,name:'Fixture',latest_version:1,owner_id:id,yaml:'whole YAML',created_at:'2026-01-01T00:00:00Z',page_more:more,page_oversized:false}]}
  }
  const app=createApp({q,secret,registrationConfig:{enabled:false},recoveryConfig:{enabled:false}}),server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}/api/blocks`,cookie='session='+jwt.sign({id,sid},secret,{expiresIn:60})
  assert.equal((await fetch(base)).status,401)
  const legacy=await fetch(base,{headers:{cookie}});assert.equal(legacy.status,200);assert.equal((await legacy.json())[0].yaml,'whole YAML');assert.equal(legacy.headers.get('cache-control'),'private, no-store')
  more=true
  const excess=await fetch(base,{headers:{cookie}});assert.equal(excess.status,413);assert.match((await excess.json()).error,/paginated library/)
  const paged=await fetch(base+'/page',{headers:{cookie}}),body=await paged.json();assert.equal(paged.status,200);assert.equal(body.nextCursor,id);assert.equal(body.items[0].yaml,'whole YAML');assert.equal(body.items[0].page_more,undefined)
})
