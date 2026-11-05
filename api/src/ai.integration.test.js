import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import YAML from 'yaml'

// Run ONLY against an isolated database and a server with a mocked provider.
// This suite creates accounts, projects and analyses. Never target a real installation.
const url = process.env.AI_TEST_URL

test('AI integration with real authentication and PostgreSQL (isolated mock server)', { skip: !url }, async t => {
  async function request(path, { method='GET', body, cookie }={}) {
    const res=await fetch(url+'/api'+path,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined})
    return {status:res.status,body:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]}
  }
  const login=async(email,password)=>{const r=await request('/login',{method:'POST',body:{email,password}});assert.equal(r.status,200);return r.cookie}
  const admin=await login('admin@local','local-ai-verification-password')
  let dev, view, outsider, project, snapshot, analysisId
  await t.test('configuration is admin-only, encrypted and redacted through HTTP',async()=>{
    assert.equal((await request('/ai')).status,401)
    const c=await request('/ai',{cookie:admin,method:'PUT',body:{provider:'deepseek',model:'deepseek-flash',enabled:true,token:'isolated-mock-token'}})
    assert.equal(c.status,200);assert.equal(c.body.tokenConfigured,true);assert.equal('token' in c.body,false)
    assert.equal((await request('/ai/test',{method:'POST',cookie:admin,body:{requestId:crypto.randomUUID()}})).status,200)
    // #30: a different provider never inherits the DeepSeek key.
    const switched=await request('/ai',{cookie:admin,method:'PUT',body:{provider:'claude',model:'claude-test-model',enabled:true,token:''}});assert.equal(switched.status,400);assert.match(JSON.stringify(switched.body),/aiNoToken/)
    assert.equal((await request('/ai',{cookie:admin})).body.provider,'deepseek')
    const preserved=await request('/ai',{cookie:admin,method:'PUT',body:{provider:'deepseek',model:'deepseek-flash',enabled:true,token:''}})
    assert.equal(preserved.body.tokenConfigured,true)
    for(const [email,role] of [['dev@local','dev'],['view@local','view'],['outsider@local','dev']]) {
      assert.equal((await request('/users',{cookie:admin,method:'POST',body:{email,password:'isolated-user-password',role}})).status,201)
    }
    dev=await login('dev@local','isolated-user-password');view=await login('view@local','isolated-user-password');outsider=await login('outsider@local','isolated-user-password')
    for(const cookie of [dev,view]) {
      assert.equal((await request('/ai',{cookie})).status,403)
      assert.equal((await request('/ai/test',{cookie,method:'POST'})).status,403)
      assert.equal((await request('/ai',{cookie,method:'PUT',body:{}})).status,403)
    }
  })
  await t.test('create a project with real seeded blocks and analyze unsaved state',async()=>{
    const blocks=await request('/blocks',{cookie:dev})
    snapshot={name:'Verificación IA aislada',nodes:[{id:crypto.randomUUID(),position:{x:100,y:100},block:YAML.parse(blocks.body[0].yaml)}],edges:[]}
    const created=await request('/projects',{method:'POST',cookie:dev,body:{yaml:YAML.stringify(snapshot)}});assert.equal(created.status,201)
    project=created.body
    snapshot.name='Pizarra con cambios sin guardar'
    const body={snapshot,action:'analyze',focus:'Alimentación',language:'es',baseRevision:1,requestId:crypto.randomUUID()}
    const path=`/projects/${project.id}/analyses`
    const result=await request(path,{method:'POST',cookie:dev,body});assert.equal(result.status,201);analysisId=result.body.id
    const replay=await request(path,{method:'POST',cookie:dev,body});assert.equal(replay.body.id,analysisId)
    // #30: the provider and model stay transparent to users; only Admin sees them.
    for (const view of [result.body,(await request(path+'/'+analysisId,{cookie:dev})).body,(await request(path+'/page',{cookie:dev})).body.items[0]]) {assert.equal('provider' in view,false);assert.equal('model' in view,false)}
    assert.equal((await request(path+'/'+analysisId,{cookie:admin})).body.provider,'deepseek')
    const detail=await request(path+'/'+analysisId,{cookie:dev});assert.deepEqual(detail.body.snapshot,snapshot);assert.match(detail.body.response,/Resumen/);assert.equal(detail.body.usage.total_tokens,300)
    const savedProject=await request('/projects/'+project.id,{cookie:dev});assert.equal(savedProject.body.revision,1);assert.notEqual(YAML.parse(savedProject.body.yaml).name,snapshot.name)
    assert.equal((await request(path,{method:'POST',cookie:dev,body:{...body,focus:'otra'}})).status,409)
  })
  await t.test('private permissions, view role, shared links and cross-project detail isolation',async()=>{
    const path=`/projects/${project.id}/analyses`
    assert.equal((await request(path,{cookie:outsider})).status,403)
    assert.equal((await request(path+'/'+analysisId,{cookie:outsider})).status,403)
    assert.equal((await request(path,{cookie:view})).status,403)
    assert.equal((await request(path)).status,401)
    assert.equal((await request('/projects/'+project.id+'/settings',{method:'PATCH',cookie:dev,body:{visibility:'public',sync_repository:'',sync_branch:'main',expectedSettingsVersion:1}})).status,200)
    assert.equal((await request(path,{cookie:view})).status,200)
    assert.equal((await request(path,{method:'POST',cookie:view,body:{snapshot,action:'analyze',baseRevision:1,language:'es',requestId:crypto.randomUUID()}})).status,403)
    const publicData=await request('/public/projects/'+project.id);assert.equal(publicData.status,200);assert.equal('analyses' in publicData.body,false)
    const other=await request('/projects',{method:'POST',cookie:admin,body:{name:'Other private project'}})
    assert.equal((await request(`/projects/${other.body.id}/analyses/${analysisId}`,{cookie:admin})).status,404)
  })
  await t.test('pagination persists independent analyses and respects project revision history',async()=>{
    const path=`/projects/${project.id}/analyses`
    for(let i=0;i<20;i++) assert.equal((await request(path,{method:'POST',cookie:dev,body:{snapshot,action:'recommend',focus:'Revisión '+i,language:'en',baseRevision:1,requestId:crypto.randomUUID()}})).status,201)
    const first=await request(path,{cookie:view});assert.equal(first.body.items.length,20);assert.equal(first.body.nextOffset,20);assert.equal('snapshot' in first.body.items[0],false)
    const second=await request(path+'?offset=20',{cookie:view});assert.equal(second.body.items.length,1);assert.equal(second.body.nextOffset,null)
    assert.equal((await request('/projects/'+project.id+'/revisions',{cookie:dev})).body.length,1)
  })
  await t.test('provider errors are safe, do not persist failed results, removal disables',async()=>{
    const path=`/projects/${project.id}/analyses`
    await request('/ai',{cookie:admin,method:'PUT',body:{provider:'deepseek',model:'deepseek-flash',enabled:true,token:'rejected-test-token'}})
    const failure=await request(path,{cookie:dev,method:'POST',body:{snapshot,action:'analyze',focus:'',language:'es',baseRevision:1,requestId:crypto.randomUUID()}})
    assert.equal(failure.status,400);assert.equal(failure.body.error,'aiInvalidToken')
    assert.equal((await request(path+'?offset=20',{cookie:dev})).body.items.length,1)
    const removed=await request('/ai',{cookie:admin,method:'PUT',body:{provider:'deepseek',model:'deepseek-flash',enabled:false,removeToken:true}})
    assert.equal(removed.body.tokenConfigured,false)
    assert.equal((await request('/ai/status',{cookie:view})).body.available,false)
    // Leave the isolated UI usable for visual verification.
    await request('/ai',{cookie:admin,method:'PUT',body:{provider:'deepseek',model:'deepseek-flash',enabled:true,token:'isolated-mock-token'}})
  })
})
