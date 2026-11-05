import test from 'node:test'
import assert from 'node:assert/strict'
import { generateRecoveryCodes, recoveryHash, matchesRecoveryCode } from './recovery.js'
import { createSecretBox } from './secrets.js'

const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', key='01'.repeat(32)
test('recovery codes use independent 128-bit random values and only namespaced hashes are persisted', () => {
  const first=generateRecoveryCodes(account),second=generateRecoveryCodes(account)
  assert.equal(first.codes.length,10);assert.equal(new Set([...first.codes,...second.codes]).size,20)
  assert.equal(new Set(first.hashes).size,10)
  for(const [i,code] of first.codes.entries()){
    assert.match(code,/^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);assert.match(first.hashes[i],/^[a-f0-9]{64}$/)
    assert.equal(matchesRecoveryCode(account,code,first.hashes[i]),true)
    assert.equal(matchesRecoveryCode(account,code.toLowerCase().replaceAll('-',''),first.hashes[i]),true)
    assert.equal(matchesRecoveryCode(other,code,first.hashes[i]),false)
    assert.notEqual(recoveryHash(account,code),code.replaceAll('-','').toLowerCase())
  }
  for(const code of [null,123,'','A'.repeat(31),'A'.repeat(33),'a'.repeat(65),'AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111'])assert.equal(recoveryHash(account,code),null)
  assert.equal(matchesRecoveryCode(account,first.codes[0],'bad'),false)
  assert.throws(()=>generateRecoveryCodes('not-an-account'),TypeError)
})
test('MFA secret encryption authenticates account/version, uses fresh nonces and never exposes the key', () => {
  const box=createSecretBox(key),envelope=box.encrypt(account,secret),second=box.encrypt(account,secret)
  assert.equal(box.available,true);assert.notDeepEqual(envelope,second)
  assert.equal(box.decrypt(account,envelope),secret);assert.equal(box.decrypt(account.toUpperCase(),envelope),secret)
  assert.deepEqual(JSON.parse(JSON.stringify(box)),{available:true})
  assert.equal(JSON.stringify(envelope).includes(secret),false)
  for(const [user,value] of [[other,envelope],[account,{...envelope,v:2}],[account,{...envelope,tag:'00'.repeat(16)}],[account,{...envelope,data:'00'.repeat(32)}],[account,{...envelope,iv:'bad'}],[account,{...envelope,data:[envelope.data]}],[account,{...envelope,extra:true}],[account,null]])assert.throws(()=>box.decrypt(user,value),{status:503,message:'mfaSecretInvalid'})
  assert.throws(()=>createSecretBox('02'.repeat(32)).decrypt(account,envelope),{status:503,message:'mfaSecretInvalid'})
})
test('missing or malformed dedicated key fails closed, while recovery hashes remain independently verifiable', () => {
  for(const invalid of [undefined,'','a'.repeat(63),'g'.repeat(64)]){
    const box=createSecretBox(invalid)
    assert.equal(box.available,false)
    assert.throws(()=>box.encrypt(account,secret),{status:503,message:'mfaKeyMissing'})
    assert.throws(()=>box.decrypt(account,{}),{status:503,message:'mfaKeyMissing'})
  }
  const code='0000-1111-2222-3333-4444-5555-6666-7777',hash=recoveryHash(account,code)
  assert.equal(matchesRecoveryCode(account,code,hash),true)
})
