import test from 'node:test'
import assert from 'node:assert/strict'
import { createGithubGate } from './gate.js'
test('provider slots are per account and bounded globally, retain disconnected work and release on errors', async () => {
  const gate=createGithubGate({maxConcurrent:2});let release
  const one=gate('a',()=>new Promise(resolve=>{release=resolve}))
  await assert.rejects(gate('a',async()=>{}),{code:'GITHUB_BUSY'})
  let releaseB;const two=gate('b',()=>new Promise(resolve=>{releaseB=resolve}))
  await assert.rejects(gate('c',async()=>{}),{code:'GITHUB_BUSY'});release();await one
  await assert.rejects(gate('c',async()=>{throw Error('synthetic')}));await gate('c',async()=>{})
  releaseB();await two;await gate('a',async()=>{})
})
