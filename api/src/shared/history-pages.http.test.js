import test from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { createApp } from '../app.js'

test('history page routes require sessions, use page handlers and disable caching', async t => {
  const id='11111111-1111-1111-1111-111111111111', sid='22222222-2222-2222-2222-222222222222', secret='synthetic-history-page-secret'
  let historyReads=0,allowed=true
  const q=async sql => {
    if(sql.startsWith('SELECT u.id,u.email,u.role,u.language,u.theme,u.display_name FROM user_sessions'))return {rows:[{id,role:'dev',email:'fixture@example.invalid',language:'es',theme:'light'}]}
    if(sql.startsWith('SELECT id,owner_id FROM blocks'))return {rows:allowed?[{id,owner_id:id}]:[]}
    if(sql.startsWith('SELECT p.id,p.created_by,p.visibility,m.role'))return {rows:allowed?[{id,created_by:id,visibility:'private'}]:[]}
    if(sql.includes('FROM block_versions v')||sql.includes('FROM project_revisions r')||sql.includes('FROM project_settings_history h')){historyReads++;return {rows:[{items:[],more:false,oversized:false}]}}
    throw new Error('Unexpected query: '+sql)
  }
  const app=createApp({q,secret,registrationConfig:{enabled:false},recoveryConfig:{enabled:false}}), server=app.listen(0,'127.0.0.1')
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const base=`http://127.0.0.1:${server.address().port}/api`, cookie='session='+jwt.sign({id,sid},secret,{expiresIn:60})
  let expectedReads=0
  for(const path of [`/projects/${id}/revisions/page`,`/blocks/${id}/versions/page`,`/projects/${id}/settings/history/page`]){
    assert.equal((await fetch(base+path)).status,401)
    for(const query of ['limit=101','limit[]=2','cursor=0','cursor=9223372036854775808','scope=all'])assert.equal((await fetch(base+path+'?'+query,{headers:{cookie}})).status,400)
    assert.equal(historyReads,expectedReads)
    const response=await fetch(base+path+'?limit=1&cursor=2',{headers:{cookie}})
    expectedReads++;assert.equal(response.status,200);assert.deepEqual(await response.json(),{items:[],nextCursor:null})
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('etag'),null)
  }
  assert.equal(historyReads,3);allowed=false
  for(const path of [`/projects/${id}/revisions/page`,`/blocks/${id}/versions/page`,`/projects/${id}/settings/history/page`])assert.equal((await fetch(base+path+'?cursor=2',{headers:{cookie}})).status,404)
  assert.equal(historyReads,3)
})
