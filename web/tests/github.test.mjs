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
test('GitHub failures are bilingual fixed text and never reflect provider diagnostics',()=>{
  for(const language of ['es','en']){
    for(const code of ['GITHUB_BUSY','GITHUB_ACCESS_DENIED','GITHUB_REPOSITORY_PUBLIC','GITHUB_BRANCH_MISSING','GITHUB_REFRESH_INTERRUPTED']) assert.notEqual(githubMessage(code,language),githubText(language,'failure'))
    assert.equal(githubMessage('secret-provider-password',language),githubText(language,'failure'))
  }
})
