import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from './app.js'
import { documentLimits, stringify } from './model.js'
test('document limits are session-protected, displayed authoritatively and enforced before persistence', async t=>{
  const id='11111111-1111-1111-1111-111111111111',sid='22222222-2222-2222-2222-222222222222',secret='synthetic-document-limits-secret'
  const q=async sql=>{assert.ok(sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme,u.display_name FROM user_sessions'));return{rows:[{id,role:'dev',email:'fixture@example.invalid',language:'en',theme:'light'}]}}
  const app=createApp({q,secret,transaction:()=>{throw Error('Unexpected write')},registrationConfig:{enabled:false},recoveryConfig:{enabled:false}}),server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}/api`,cookie='session='+jwt.sign({id,sid},secret,{expiresIn:60})
  assert.equal((await fetch(base+'/document-limits')).status,401)
  const response=await fetch(base+'/document-limits',{headers:{cookie}});assert.deepEqual(await response.json(),documentLimits);assert.equal(response.headers.get('cache-control'),'private, no-store')
  const yaml=stringify({name:'Fixture',nodes:Array.from({length:501},(_,i)=>({id:'n'+i,position:{x:0,y:0},block:{name:'Block',function:'Measure',ports:[{id:'p',label:'P',protocol:'IO',direction:'in'}]}})),edges:[]})
  for(const path of ['/validate','/projects']){
    const result=await fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({kind:'project',yaml})})
    assert.equal(result.status,400);assert.match((await result.json()).error,/maximum 500/)
  }
  const result=await fetch(base+'/validate',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({kind:'project',yaml:'a: &cycle {next: *cycle}'})})
  assert.equal(result.status,400)
})
