import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { githubLinkConfig } from './config.js'
import { loadSecretFiles } from '../config/secrets.js'

test('GitHub user authorization is optional, off by default and requires independent protected secrets', t => {
  assert.equal(githubLinkConfig({}).available, false)
  assert.equal(githubLinkConfig({}).connectEnabled, false)
  const env = { PUBLIC_ORIGIN: 'https://sugar.example.invalid', GITHUB_CLIENT_ID: 'Iv1.synthetic', GITHUB_CLIENT_SECRET: 'synthetic-secret', GITHUB_USER_ENCRYPTION_KEY: '12'.repeat(32), GITHUB_CONNECT_ENABLED: 'true' }
  assert.equal(githubLinkConfig(env).available, true); assert.equal(githubLinkConfig(env).connectEnabled, true)
  for (const change of [{ GITHUB_CLIENT_SECRET: '' },{ GITHUB_USER_ENCRYPTION_KEY: '' },{ PUBLIC_ORIGIN: 'http://public.example.invalid' }]) assert.equal(githubLinkConfig({ ...env, ...change }).available, false)
  for (const change of [{ GITHUB_CONNECT_ENABLED: 'yes' },{ GITHUB_CLIENT_ID: '../private' },{ GITHUB_CLIENT_SECRET: 'private\nsecret' }]) assert.throws(() => githubLinkConfig({ ...env, ...change }), { code: 'SECRET_CONFIG' })
  for (const name of ['AI_ENCRYPTION_KEY','MAIL_ENCRYPTION_KEY','MFA_ENCRYPTION_KEY']) assert.throws(() => loadSecretFiles({ ...env, [name]: env.GITHUB_USER_ENCRYPTION_KEY }), { code: 'SECRET_CONFIG' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sugar-github-file-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const secret = path.join(dir, 'private-input'); fs.writeFileSync(secret, env.GITHUB_CLIENT_SECRET + '\n', { mode: 0o600 })
  const value = { GITHUB_CLIENT_SECRET_FILE: secret }; loadSecretFiles(value); assert.equal(value.GITHUB_CLIENT_SECRET, env.GITHUB_CLIENT_SECRET)
  fs.chmodSync(secret, 0o640); assert.throws(() => loadSecretFiles({ GITHUB_CLIENT_SECRET_FILE: secret }), { code: 'SECRET_CONFIG' })
  fs.chmodSync(secret, 0o600); fs.writeFileSync(secret, env.GITHUB_USER_ENCRYPTION_KEY + '\n')
  const encryption = { GITHUB_USER_ENCRYPTION_KEY_FILE: secret }; loadSecretFiles(encryption); assert.equal(encryption.GITHUB_USER_ENCRYPTION_KEY, env.GITHUB_USER_ENCRYPTION_KEY)
})
