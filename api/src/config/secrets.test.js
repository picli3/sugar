import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSecretFiles } from './secrets.js'

test('file secrets enforce permissions, reject links/conflicts and never echo contents or paths', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sugar-secret-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const file=path.join(dir,'private-input'), value='isolated-sensitive-fixture-123456789'
  fs.writeFileSync(file,value+'\n',{mode:0o600})
  const env={ADMIN_PASSWORD_FILE:file};loadSecretFiles(env);assert.equal(env.ADMIN_PASSWORD,value)
  for(const mode of [0o644,0o640,0o666,0o755]){fs.chmodSync(file,mode);assert.throws(()=>loadSecretFiles({ADMIN_PASSWORD_FILE:file}),e=>{assert.equal(e.code,'SECRET_CONFIG');assert.equal(e.message.includes(value),false);assert.equal(e.message.includes(file),false);return true})}
  fs.chmodSync(file,0o400);loadSecretFiles({ADMIN_PASSWORD_FILE:file})
  fs.symlinkSync(file,path.join(dir,'link'));assert.throws(()=>loadSecretFiles({ADMIN_PASSWORD_FILE:path.join(dir,'link')}),{code:'SECRET_CONFIG'})
  assert.throws(()=>loadSecretFiles({ADMIN_PASSWORD:'existing',ADMIN_PASSWORD_FILE:file}),{code:'SECRET_CONFIG'})
  assert.throws(()=>loadSecretFiles({JWT_SECRET:'short'}),{code:'SECRET_CONFIG'})
  assert.throws(()=>loadSecretFiles({AI_ENCRYPTION_KEY:'invalid'}),{code:'SECRET_CONFIG'})
  fs.chmodSync(file,0o600);fs.writeFileSync(file,'x'.repeat(65537));assert.throws(()=>loadSecretFiles({ADMIN_PASSWORD_FILE:file}),{code:'SECRET_CONFIG'})
  fs.writeFileSync(file,'');assert.throws(()=>loadSecretFiles({ADMIN_PASSWORD_FILE:file}),{code:'SECRET_CONFIG'})
})


test('MFA has an optional independent key, protected file loading and enrollment defaults', t => {
  loadSecretFiles({})
  for (const value of ['invalid','g'.repeat(64),'a'.repeat(63)]) assert.throws(() => loadSecretFiles({ MFA_ENCRYPTION_KEY: value }), { code: 'SECRET_CONFIG' })
  for (const name of ['AI_ENCRYPTION_KEY','MAIL_ENCRYPTION_KEY']) assert.throws(() => loadSecretFiles({ MFA_ENCRYPTION_KEY: 'a'.repeat(64), [name]: 'A'.repeat(64) }), { code: 'SECRET_CONFIG' })
  assert.throws(() => loadSecretFiles({ MFA_ENROLLMENT_ENABLED: 'yes' }), { code: 'SECRET_CONFIG' })
  loadSecretFiles({ MFA_ENCRYPTION_KEY: 'c'.repeat(64), AI_ENCRYPTION_KEY: 'a'.repeat(64), MAIL_ENCRYPTION_KEY: 'b'.repeat(64), MFA_ENROLLMENT_ENABLED: 'false' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugar-mfa-key-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'private-input'); fs.writeFileSync(file, 'c'.repeat(64) + '\n', { mode: 0o600 })
  const env = { MFA_ENCRYPTION_KEY_FILE: file }; loadSecretFiles(env); assert.equal(env.MFA_ENCRYPTION_KEY, 'c'.repeat(64))
  assert.throws(() => loadSecretFiles({ MFA_ENCRYPTION_KEY_FILE: file, MFA_ENCRYPTION_KEY: 'c'.repeat(64) }), { code: 'SECRET_CONFIG' })
  fs.chmodSync(file, 0o644); assert.throws(() => loadSecretFiles({ MFA_ENCRYPTION_KEY_FILE: file }), { code: 'SECRET_CONFIG' })
})
