import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import { createTransaction } from '../db.js'
import { initSessionDb, createSessionRepository } from '../auth/sessions.js'
import { createUserRepository } from '../users/repository.js'
import { initGithubLinkDb } from './migration.js'
import { createGithubLinkRepository } from './repository.js'
import { createGithubLinkService } from './service.js'
import { githubLinkConfig } from './config.js'
import { githubError } from './protocol.js'
const url = process.env.API_TEST_DATABASE_URL

test('GitHub OAuth binds one-use PKCE to account/session and credentials survive concurrency, quotas and failed reads', { skip: !url }, async t => {
  const schema = 'github_link_' + crypto.randomBytes(8).toString('hex'), root = new pg.Pool({ connectionString: url })
  await root.query('CREATE SCHEMA ' + schema)
  const db = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => db.query(sql, args), transaction = createTransaction(db)
  t.after(async () => { await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end() })
  await q(`CREATE TABLE users(id uuid PRIMARY KEY,email text,role text,active boolean DEFAULT true,language text DEFAULT 'es',theme text DEFAULT 'light',password_hash text)`)
  await q('CREATE TABLE settings(key text PRIMARY KEY,value jsonb NOT NULL)')
  await initSessionDb(q); await initGithubLinkDb(q); await initGithubLinkDb(q)
  const sessions = createSessionRepository(q, transaction), users = createUserRepository(q, transaction), repository = createGithubLinkRepository(q, transaction)
  const config = githubLinkConfig({ PUBLIC_ORIGIN: 'https://sugar.example.invalid', GITHUB_CLIENT_ID: 'Iv1.synthetic', GITHUB_CLIENT_SECRET: 'synthetic-secret', GITHUB_USER_ENCRYPTION_KEY: '11'.repeat(32), GITHUB_CONNECT_ENABLED: 'true' })
  const password = 'isolated-github-password', hash = await bcrypt.hash(password, 4)
  const actors = []
  for (const role of ['dev','dev','view']) {
    const id = crypto.randomUUID(), sid = crypto.randomUUID()
    await q('INSERT INTO users(id,email,role,password_hash) VALUES($1,$2,$3,$4)', [id, id + '@example.invalid', role, hash])
    await sessions.create(sid, id, hash, new Date(Date.now() + 3600000)); actors.push({ id, role, sid })
  }
  const [a,b,view] = actors, counters = { exchange: 0, refresh: 0, reads: 0, revoked: 0 }, identities = new Map()
  let exchangeHook, refreshHook, readError, lastAccess
  const minted = githubId => {
    const accessToken = 'ghu_' + crypto.randomBytes(20).toString('hex'), refreshToken = 'ghr_' + crypto.randomBytes(20).toString('hex')
    identities.set(accessToken, { id: githubId, login: 'fixture-' + githubId }); lastAccess = accessToken
    return { accessToken, refreshToken, expiresAt: new Date(Date.now() + 28800000), refreshExpiresAt: new Date(Date.now() + 15897600000) }
  }
  const client = {
    exchange: async input => { counters.exchange++; assert.match(input.verifier, /^[A-Za-z0-9_-]{43}$/); if (exchangeHook) await exchangeHook(); return minted(input.code === 'for-b' ? '222' : '111') },
    identity: async token => { assert(identities.has(token)); return identities.get(token) },
    refresh: async token => { counters.refresh++; assert.match(token, /^ghr_/); if (refreshHook) await refreshHook(); return minted('111') },
    installations: async token => { counters.reads++; assert(identities.has(token)); if (readError) throw readError; return [{ id: '7', login: 'fixture' }] },
    repositories: async token => { assert(identities.has(token)); return [] },
    revoke: async token => { counters.revoked++; assert.match(token, /^ghu_/) },
  }
  const service = () => createGithubLinkService({ repository, users, config, client })
  const begin = async (actor = a) => new URL((await service().begin(actor, actor.sid, { currentPassword: password })).authorizationUrl).searchParams.get('state')
  const complete = (state, actor = a) => service().complete(actor, actor.sid, { state, code: actor === b ? 'for-b' : 'for-a' })
  const raw = async (actor = a) => (await q('SELECT * FROM github_links WHERE user_id=$1', [actor.id])).rows[0]
  const pending = async (actor = a) => (await q('SELECT * FROM github_oauth_states WHERE user_id=$1', [actor.id])).rows[0]
  await assert.rejects(service().begin(a, a.sid, { currentPassword: 'bad' }), { code: 'GITHUB_PASSWORD_INVALID' })
  await assert.rejects(service().begin(view, view.sid, { currentPassword: password }), { code: 'GITHUB_ACCOUNT_REQUIRED' })
  await assert.rejects(service().begin(a, a.sid, { currentPassword: password, userId: b.id }), { code: 'GITHUB_INPUT_INVALID' })
  assert.equal(await raw(), undefined)
  let state = await begin(), oldState = state; state = await begin()
  assert.notEqual((await pending()).state_hash, state); assert.equal(JSON.stringify(await pending()).includes(state), false)
  await assert.rejects(complete(oldState), { code: 'GITHUB_OAUTH_STATE_INVALID' })
  await assert.rejects(service().complete(a, b.sid, { state, code: 'for-a' }), { code: 'GITHUB_SESSION_CHANGED' })
  await assert.rejects(complete(state, b), { code: 'GITHUB_OAUTH_STATE_INVALID' }); assert.equal(counters.exchange, 0)
  const busy = createGithubLinkService({ repository, users, config, client, runProvider: async () => { throw githubError('GITHUB_REFRESH_IN_PROGRESS', 429) } })
  await assert.rejects(busy.complete(a, a.sid, { state, code: 'for-a' }), { status: 429 }); assert.equal((await pending()).claimed, false)
  const results = await Promise.allSettled([complete(state), complete(state)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(counters.exchange, 1)
  const first = await raw(); assert.equal(await pending(), undefined); assert.equal(JSON.stringify(first).includes(lastAccess), false)
  assert.deepEqual((await service().status(a)).account, { id: '111', login: 'fixture-111' })
  assert.equal(JSON.stringify(await service().status(a)).includes('box'), false)
  await assert.rejects(q('UPDATE github_links SET access_box=$2 WHERE user_id=$1', [a.id, { ...first.access_box, extra: true }]), { code: '23514' })
  await assert.rejects(q('UPDATE github_links SET access_box=$2 WHERE user_id=$1', [a.id, config.box.encrypt({ userId: a.id, linkId: first.id, purpose: 'access' }, 'x'.repeat(513))]), { code: '23514' })
  await assert.rejects(q("UPDATE github_links SET github_user_id='0' WHERE user_id=$1", [a.id]), { code: '23514' })
  await assert.rejects(q('UPDATE github_links SET refresh_started_at=now() WHERE user_id=$1', [a.id]), { code: '23514' })
  await complete(await begin(b), b)
  const other = await raw(b); assert.notEqual(other.id, first.id)
  await assert.rejects(service().withCredential(a.id, { sessionId: b.sid }, () => {}), { code: 'GITHUB_SESSION_CHANGED' })
  const reads = counters.reads
  await q('UPDATE github_links SET access_box=$2 WHERE user_id=$1', [a.id, other.access_box])
  await assert.rejects(service().installations(a, a.sid), { code: 'GITHUB_SECRET_INVALID' }); assert.equal(counters.reads, reads)
  await q('UPDATE github_links SET access_box=$2 WHERE user_id=$1', [a.id, first.access_box])
  await service().installations(a, a.sid)
  await initGithubLinkDb(q); assert.deepEqual(await raw(), first)
  // Commit refresh intent before calling the provider; separate replicas cannot reuse it.
  await q("UPDATE github_links SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.id])
  let release, entered; const ready = new Promise(resolve => { entered = resolve }), hold = new Promise(resolve => { release = resolve })
  refreshHook = async () => { assert.ok((await raw()).refresh_nonce); entered(); await hold }
  const one = service().installations(a, a.sid); await ready
  await assert.rejects(service().installations(a, a.sid), { code: 'GITHUB_REFRESH_IN_PROGRESS' }); assert.equal(counters.refresh, 1)
  release(); await one; refreshHook = undefined
  const refreshed = await raw(); assert.equal(refreshed.refresh_nonce, null)
  assert.equal(config.box.decrypt({ userId: a.id, linkId: refreshed.id, purpose: 'access' }, refreshed.access_box), lastAccess)
  // A failed catalog read cannot roll back the successful one-use refresh.
  await q("UPDATE github_links SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.id]); readError = githubError('GITHUB_ACCESS_DENIED', 403)
  await assert.rejects(service().installations(a, a.sid), { code: 'GITHUB_ACCESS_DENIED' }); readError = undefined
  assert.equal((await raw()).refresh_nonce, null); const refreshes = counters.refresh
  await service().installations(a, a.sid); assert.equal(counters.refresh, refreshes)
  // An ambiguous refresh is never sent again, even from another service instance.
  await q("UPDATE github_links SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.id]); refreshHook = async () => { throw githubError('GITHUB_TIMEOUT', 504) }
  await assert.rejects(service().installations(a, a.sid), { code: 'GITHUB_TIMEOUT' }); const burned = counters.refresh
  await assert.rejects(service().installations(a, a.sid), { code: 'GITHUB_REFRESH_INTERRUPTED' }); assert.equal(counters.refresh, burned)
  assert.equal((await service().status(a)).needsReauthorization, true); refreshHook = undefined
  await complete(await begin()); assert.equal((await raw()).refresh_nonce, null)
  // Account/credential changes discard BOTH pending OAuth and linked credentials.
  state = await begin(); await q('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [a.id])
  assert.equal(await raw(), undefined); assert.equal(await pending(), undefined); assert.ok(await raw(b))
  await assert.rejects(complete(state), { code: 'GITHUB_SESSION_CHANGED' })
  a.sid = crypto.randomUUID(); await sessions.create(a.sid, a.id, hash, new Date(Date.now()+3600000))
  state = await begin(); await q("UPDATE github_oauth_states SET expires_at=now()-interval '1 second' WHERE user_id=$1", [a.id]); const exchanges = counters.exchange
  await assert.rejects(complete(state), { code: 'GITHUB_OAUTH_STATE_INVALID' }); assert.equal(counters.exchange, exchanges)
  state = await begin()
  exchangeHook = async () => { await q('UPDATE users SET active=false WHERE id=$1', [a.id]) }
  await assert.rejects(complete(state), { code: 'GITHUB_ACCOUNT_REQUIRED' }); exchangeHook = undefined
  assert.equal(await raw(), undefined); assert.equal(await pending(), undefined)
  assert.ok(counters.revoked > 0); assert.ok(await raw(b))
  await q('UPDATE users SET active=true WHERE id=$1', [a.id]); a.sid = crypto.randomUUID(); await sessions.create(a.sid, a.id, hash, new Date(Date.now()+3600000))
  await complete(await begin()); readError = githubError('GITHUB_USER_REVOKED', 409)
  await assert.rejects(service().installations(a, a.sid), { code: 'GITHUB_USER_REVOKED' }); readError = undefined
  assert.equal(await raw(), undefined); assert.ok(await raw(b))
  await complete(await begin()); await service().disconnect(a, a.sid, { currentPassword: password })
  assert.equal(await raw(), undefined); assert.equal(await pending(), undefined); assert.ok(await raw(b))
  await q("UPDATE users SET role='view' WHERE id=$1", [b.id]); assert.equal(await raw(b), undefined)
})
