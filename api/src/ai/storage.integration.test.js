import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import pg from 'pg'
import { createTransaction } from '../db.js'
import { initAiDb, registerAi, fingerprint } from '../ai.js'
import { createAiQuotas } from './quotas.js'
import { createAiStorage, aiResponseBytes } from './storage.js'
import { initDocumentStorage } from '../document-storage/migration.js'
import { defaultDocumentStorage } from '../document-storage/config.js'
import { createDocumentStorageRepository } from '../document-storage/repository.js'
import { createDocumentStorage } from '../document-storage/service.js'
import { stringify } from '../model.js'
const url = process.env.API_TEST_DATABASE_URL
test('AI storage reserves before billing, settles within capacity, coordinates writers and retains legacy usage', { skip: !url }, async t => {
  const schema = 'ai_storage_' + crypto.randomBytes(8).toString('hex'), admin = new pg.Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new pg.Pool({ connectionString: url, options: '-c search_path=' + schema }), q = (sql, args) => pool.query(sql, args), transaction = createTransaction(pool)
  t.after(async () => { await pool.end(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end() })
  await q('CREATE TABLE users(id uuid PRIMARY KEY,email text)')
  await q('CREATE TABLE projects(id uuid PRIMARY KEY,name text,yaml text,created_by uuid,deleted_at timestamptz)')
  await q('CREATE TABLE blocks(id uuid PRIMARY KEY,name text,owner_id uuid)')
  await q('CREATE TABLE project_revisions(project_id uuid,revision int,yaml text,summary text)')
  await q('CREATE TABLE block_versions(block_id uuid,yaml text,summary text)')
  await q('CREATE TABLE sync_jobs(kind text,record_id uuid,yaml text,target_repository text,target_branch text)')
  await q('CREATE TABLE settings(key text PRIMARY KEY,value jsonb)')
  await initAiDb(q); await initDocumentStorage(q)
  const owner = crypto.randomUUID(), editor = crypto.randomUUID(), project = crypto.randomUUID()
  const snapshot = { name: 'Fixture', nodes: [{ id: 'n', position: { x: 0, y: 0 }, block: { name: 'Fixture', function: 'Control', ports: [{ id: 'p', label: 'P', protocol: 'IO', direction: 'in' }] } }], edges: [] }
  await q("INSERT INTO users VALUES($1,'owner@example.invalid'),($2,'editor@example.invalid')", [owner, editor])
  await q('INSERT INTO projects VALUES($1,$2,$3,$4,NULL)', [project, snapshot.name, stringify(snapshot), owner])
  await q("INSERT INTO settings VALUES('ai',$1::jsonb)", [JSON.stringify({ enabled: true, token: { fake: true }, model: 'deepseek-flash' })])
  const repository = createDocumentStorageRepository(q), docs = createDocumentStorage({ repository, transaction }), storage = createAiStorage(repository)
  const quota = createAiQuotas({ q, transaction, storage }), otherQuota = createAiQuotas({ q, transaction, storage })
  const configure = async patch => docs.configure({ ...defaultDocumentStorage, ...patch, expectedVersion: (await docs.configuration()).version })
  const body = () => ({ snapshot, action: 'analyze', focus: '', language: 'es', baseRevision: 1, requestId: crypto.randomUUID() })
  const plan = { snapshot, snapshot_hash: fingerprint(snapshot), action: 'analyze', focus: '', language: 'es', provider: 'deepseek', model: 'deepseek-flash' }
  let providerCalls = 0, providerMode = 'ok', release, reached
  const app = express(); app.use(express.json())
  app.use((req, _res, next) => { req.user = { id: editor, role: 'dev', language: 'es' }; next() })
  registerAi(app, { q, quota, requireEdit: () => {}, requireProject: async req => {
    assert.equal(req.params.id, project); return { id: project, revision: 1 }
  }, callProvider: async () => {
    providerCalls++
    if (providerMode === 'wait') { reached(); await new Promise(resolve => { release = resolve }) }
    if (providerMode === 'fail') throw Object.assign(Error('aiNoBalance'), { status: 402 })
    return { response: providerMode === 'large' || providerMode === 'over' ? 'ñ'.repeat(aiResponseBytes / 2) + (providerMode === 'over' ? 'x' : '') : 'Saved ñ result', usage: { total_tokens: 42 } }
  } })
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const request = async input => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project}/analyses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    return { status: response.status, body: await response.json() }
  }
  await configure({ platformBytes: 0 })
  assert.deepEqual(await request(body()), { status: 409, body: { error: 'aiStorageQuota' } })
  assert.equal(providerCalls, 0); assert.equal((await quota.summary(editor)).user.requests, 0)
  assert.equal((await q('SELECT count(*) AS total FROM ai_calls')).rows[0].total, '0')
  await q('UPDATE document_storage_config SET value=$1::jsonb', [JSON.stringify({ ...defaultDocumentStorage, userBytes: 'invalid' })])
  assert.deepEqual(await request(body()), { status: 503, body: { error: 'aiStorageUnavailable' } })
  assert.equal(providerCalls, 0)
  await configure({})
  providerMode = 'wait'
  const started = new Promise(resolve => { reached = resolve }), input = body(), pending = request(input)
  await started
  const reserved = await docs.configuration(), own = await docs.summary(owner), editing = await docs.summary(editor)
  assert.equal(reserved.usage.ai_calls, '1'); assert.ok(BigInt(reserved.usage.ai_reserved_bytes) > 1024n * 1024n)
  assert.equal(own.usage.ai_calls, '1'); assert.equal(editing.usage.ai_calls, '0')
  assert.equal(editing.limits.platformBytes, undefined)
  // Lowering capacity during an already admitted paid call must not discard its result.
  await configure({ platformBytes: 0, userBytes: 0 }); release()
  const saved = await pending
  assert.equal(saved.status, 201)
  const settled = await docs.configuration()
  assert.equal(settled.usage.analyses, '1'); assert.equal(settled.usage.ai_reserved_bytes, '0')
  assert.ok(BigInt(settled.usage.bytes) < BigInt(reserved.usage.bytes))
  assert.equal((await request(input)).body.id, saved.body.id); assert.equal(providerCalls, 1)
  assert.equal((await request({ ...input, focus: 'different' })).status, 409)
  await configure({}); providerMode = 'fail'
  assert.equal((await request(body())).status, 402)
  assert.equal((await docs.configuration()).usage.ai_reserved_bytes, '0')
  assert.equal((await docs.configuration()).usage.ai_calls, '2')
  providerMode = 'large'
  assert.equal((await request(body())).status, 201)
  assert.equal((await q('SELECT max(octet_length(response)) AS size FROM project_analyses')).rows[0].size, aiResponseBytes)
  providerMode = 'over'
  assert.deepEqual(await request(body()), { status: 502, body: { error: 'aiProviderTooLarge' } })
  assert.equal((await docs.configuration()).usage.analyses, '2')
  assert.equal((await docs.configuration()).usage.ai_reserved_bytes, '0')
  await q('UPDATE projects SET deleted_at=now() WHERE id=$1', [project])
  const retained = (await docs.configuration()).usage
  await initAiDb(q); await initDocumentStorage(q)
  assert.deepEqual((await docs.configuration()).usage, retained)
  assert.equal((await q('SELECT response FROM project_analyses WHERE id=$1', [saved.body.id])).rows[0].response, 'Saved ñ result')
  await q('UPDATE projects SET deleted_at=NULL WHERE id=$1', [project])
  const connection = await quota.reserve(editor, crypto.randomUUID(), 'test-connection', 100)
  assert.equal((await docs.summary(editor)).usage.ai_calls, '1')
  assert.equal((await docs.summary(editor)).usage.ai_reserved_bytes, '0')
  await quota.settle(connection.id, { total_tokens: 1 })
  await q('DELETE FROM ai_calls'); await q('DELETE FROM project_analyses')
  const base = BigInt((await docs.configuration()).usage.bytes), hash = 'a'.repeat(64)
  const probe = await quota.reserve(owner, crypto.randomUUID(), hash, 100, project, plan)
  const reserveBytes = BigInt((await q('SELECT storage_bytes FROM ai_calls WHERE id=$1', [probe.id])).rows[0].storage_bytes), cost = reserveBytes + 1088n
  await q('DELETE FROM ai_calls')
  await configure({ userBytes: Number(base + cost - 1n) })
  await assert.rejects(quota.reserve(editor, crypto.randomUUID(), hash, 100, project, plan), /aiStorageQuota/)
  await configure({ userBytes: Number(base + cost) })
  const exactPersonal = await quota.reserve(editor, crypto.randomUUID(), hash, 100, project, plan)
  assert.equal((await docs.summary(owner)).usage.bytes, String(base + cost))
  assert.equal((await docs.summary(editor)).usage.ai_calls, '0')
  await quota.abandon(exactPersonal.id); await q('DELETE FROM ai_calls')
  await configure({ platformBytes: Number(base + cost) })
  const races = await Promise.allSettled([quota.reserve(owner, crypto.randomUUID(), hash, 100, project, plan), otherQuota.reserve(editor, crypto.randomUUID(), hash, 100, project, plan)])
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(races.find(result => result.status === 'rejected').reason.message, 'aiStorageQuota')
  const winner = races.find(result => result.status === 'fulfilled').value
  assert.equal((await docs.configuration()).usage.bytes, String(base + cost))
  await quota.abandon(winner.id)
  assert.equal((await docs.configuration()).usage.ai_reserved_bytes, '0')
  assert.equal((await docs.configuration()).usage.ai_calls, '1')
  await q('DELETE FROM ai_calls')
  // A document writer and an AI admission share one capacity lock across services.
  const mixed = await Promise.allSettled([
    quota.reserve(owner, crypto.randomUUID(), hash, 100, project, plan),
    docs.write('project', project, tx => tx("INSERT INTO project_revisions VALUES($1,1,repeat('d',$2),'')", [project, Number(cost)])),
  ])
  assert.equal(mixed.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(mixed.find(result => result.status === 'rejected').reason.status, 409)
  assert.equal((await docs.configuration()).usage.bytes, String(base + cost))
  await q('DELETE FROM ai_calls'); await q('DELETE FROM project_revisions'); await configure({})
  const uncertainId = crypto.randomUUID(), uncertain = await quota.reserve(owner, uncertainId, hash, 100, project, plan)
  await q("UPDATE ai_calls SET created_at=now()-interval '10 minutes' WHERE id=$1", [uncertain.id])
  const another = await otherQuota.reserve(editor, crypto.randomUUID(), hash, 100, project, plan)
  assert.equal((await q('SELECT status FROM ai_calls WHERE id=$1', [uncertain.id])).rows[0].status, 'uncertain')
  assert.equal((await docs.configuration()).usage.ai_reserved_bytes, String(2n * reserveBytes))
  await assert.rejects(quota.reserve(owner, uncertainId, hash, 100, project, plan), /aiRequestUsed/)
  await quota.abandon(uncertain.id); await quota.abandon(another.id)
  assert.equal((await docs.configuration()).usage.ai_reserved_bytes, '0')
  assert.equal(providerCalls, 4)
})
