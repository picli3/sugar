import test from 'node:test'
import assert from 'node:assert/strict'
import { takeGithubCallback, githubMessage, githubText } from '../src/github.ts'
test('GitHub callback removes all URL secrets before use, never accepts duplicates/extra keys and ignores unrelated pages',()=>{
  const state='s'.repeat(43), seen=[]
  const history={replaceState:(_state,_unused,path)=>seen.push(path)}
  assert.deepEqual(takeGithubCallback({pathname:'/oauth/github/callback',search:'?code=fixture&state='+state,hash:''},history),{code:'fixture',state})
  for(const search of ['?code=x&state='+state+'&state='+state,'?code=x&state='+state+'&next=https://attacker.invalid','?code=secret','?error=unknown&state='+state]) assert.deepEqual(takeGithubCallback({pathname:'/oauth/github/callback',search,hash:''},history),{error:'invalid'})
  assert.deepEqual(takeGithubCallback({pathname:'/oauth/github/callback',search:'?error=access_denied&state='+state,hash:''},history),{error:'denied'})
  assert.equal(takeGithubCallback({pathname:'/',search:'?code=unrelated',hash:''},history),null)
  assert.deepEqual(seen,Array(6).fill('/'))
})
test('GitHub App installation returns are explained, and installation markers alongside a Sugar flow are ignored',()=>{
  const state='s'.repeat(43), history={replaceState:()=>{}}, take=search=>takeGithubCallback({pathname:'/oauth/github/callback',search,hash:''},history)
  assert.deepEqual(take('?installation_id=123456&setup_action=install'),{error:'installed'})
  assert.deepEqual(take('?code=abc&installation_id=123456&setup_action=install'),{error:'installed'})
  assert.deepEqual(take('?code=abc&state='+state+'&installation_id=123456&setup_action=install'),{code:'abc',state})
  assert.deepEqual(take('?code=abc&state='+state+'&setup_action=update'),{code:'abc',state})
  for(const search of ['?installation_id=12a&setup_action=install','?installation_id=1&setup_action=hack','?installation_id=1&installation_id=2','?code=abc&state='+state+'&installation_id=x','?installation_id=1&next=https://attacker.invalid']) assert.deepEqual(take(search),{error:'invalid'},search)
})
test('GitHub failures are bilingual fixed text and never reflect provider diagnostics',()=>{
  for(const language of ['es','en']){
    for(const code of ['GITHUB_BUSY','GITHUB_ACCESS_DENIED','GITHUB_REPOSITORY_PUBLIC','GITHUB_BRANCH_MISSING','GITHUB_REFRESH_INTERRUPTED']) assert.notEqual(githubMessage(code,language),githubText(language,'failure'))
    assert.equal(githubMessage('secret-provider-password',language),githubText(language,'failure'))
  }
})
