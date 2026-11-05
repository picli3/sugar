import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import pg from 'pg'
import { createProjectRepository } from './projects/repository.js'
import { createProjectService } from './projects/service.js'
import { createBlockRepository } from './blocks/repository.js'
import { createBlockService } from './blocks/service.js'
import { enqueue } from './github.js'
import { createTransaction } from './db.js'
import { replaceEmbeddedImages } from './images.js'
import { projectCategoryIcons, validateCategory } from './categories.js'

// Explicit opt-in: use only the disposable icons/API installation in CI, never production.
const url = process.env.API_TEST_URL
const databaseUrl = process.env.API_TEST_DATABASE_URL
const password = 'local-user-password'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNQaHjQAMIMMAYARRIIAU62oz0AAAAASUVORK5CYII='
const block = { name: 'Sensor', function: 'Medir', category: 'sensores', ports: [{ id: 'power', label: '3V3', protocol: 'POWER', direction: 'in' }] }
const document = name => ({ name, nodes: [{ id: 'sensor', position: { x: 10, y: 20 }, block }], edges: [] })

test('modular API preserves authenticated contracts and transactional behavior (isolated PostgreSQL)', { skip: !url }, async t => {
  const suffix = crypto.randomUUID().slice(0, 8)
  async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const type = response.headers.get('content-type') || ''
    const data = type.includes('application/json') ? await response.json() : type.startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : await response.text()
    return { status: response.status, body: data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  async function login(email, value = password) {
    const result = await request('/login', { method: 'POST', body: { email, password: value } })
    assert.equal(result.status, 200)
    return result.cookie
  }
  const admin = await login('admin@local', 'local-icons-verification-password')
  const accounts = {}
  for (const role of ['dev', 'view', 'other']) {
    const email = `${role}-${suffix}@local`
    const result = await request('/users', { method: 'POST', cookie: admin, body: { email, password, role: role === 'other' ? 'dev' : role } })
    assert.equal(result.status, 201)
    accounts[role] = { ...result.body, cookie: await login(email) }
  }
  const owner = accounts.dev, viewer = accounts.view, outsider = accounts.other
  let projectId, blockId
  const projectPath = () => '/projects/' + projectId
  const ownerRequest = (path, options = {}) => request(path, { cookie: owner.cookie, ...options })

  await t.test('users, preferences, password change, role changes and deactivation', async () => {
    assert.equal((await request('/users', { cookie: owner.cookie })).status, 403)
    assert.equal((await request('/me')).status, 401)
    let result = await ownerRequest('/me', { method: 'PATCH', body: { language: 'en', theme: 'dark' } })
    assert.equal(result.status, 200); assert.equal(result.body.theme, 'dark'); assert.equal(result.body.language, 'en')
    assert.equal((await ownerRequest('/me', { method: 'PATCH', body: { theme: 'unknown' } })).status, 400)
    assert.equal((await ownerRequest('/me/password', { method: 'POST', body: { currentPassword: password, newPassword: 'short' } })).status, 400)
    assert.equal((await ownerRequest('/me/password', { method: 'POST', body: { currentPassword: 'wrong-password', newPassword: 'changed-user-password' } })).status, 400)
    assert.equal((await ownerRequest('/me/password', { method: 'POST', body: { currentPassword: password, newPassword: 'changed-user-password' } })).status, 200)
    assert.equal((await request('/login', { method: 'POST', body: { email: owner.email, password } })).status, 401)
    owner.cookie = await login(owner.email, 'changed-user-password')
    const me = await request('/me', { cookie: admin })
    assert.equal((await request('/users/' + me.body.id, { method: 'PATCH', cookie: admin, body: { role: 'view' } })).status, 400)
    assert.equal((await request('/users/' + me.body.id, { method: 'DELETE', cookie: admin })).status, 400)
    const created = await request('/users', { method: 'POST', cookie: admin, body: { email: `inactive-${suffix}@local`, password, role: 'dev' } })
    const cookie = await login(created.body.email)
    result = await request('/users/' + created.body.id, { method: 'PATCH', cookie: admin, body: { role: 'view' } })
    assert.equal(result.body.role, 'view')
    assert.equal((await request('/me', { cookie })).body.role, 'view')
    assert.equal((await request('/users/' + created.body.id, { method: 'DELETE', cookie: admin })).status, 200)
    assert.equal((await request('/me', { cookie })).status, 401)
  })

  await t.test('private projects, public projection, owner-only settings and GitHub queue permissions', async () => {
    let result = await ownerRequest('/projects', { method: 'POST', body: { yaml: JSON.stringify(document('Private ' + suffix)) } })
    assert.equal(result.status, 201); projectId = result.body.id; assert.equal(result.body.revision, 1)
    assert.equal((await request('/projects', { method: 'POST', cookie: viewer.cookie, body: { name: 'Denied' } })).status, 403)
    for (const path of ['', '/export', '/revisions', '/diff?from=1&to=1', '/sync']) assert.equal((await request(projectPath() + path, { cookie: outsider.cookie })).status, 403)
    assert.equal((await request('/public/projects/' + projectId)).status, 404)
    assert.equal((await request('/projects/not-a-uuid', { cookie: admin })).status, 400)
    assert.equal((await request('/projects/' + crypto.randomUUID(), { cookie: admin })).status, 404)
    assert.equal((await ownerRequest(projectPath(), { method: 'PUT', body: { yaml: JSON.stringify(document('Invalid')), expectedRevision: 0 } })).status, 400)
    result = await ownerRequest(projectPath() + '/settings', { method: 'PATCH', body: { visibility: 'public', sync_repository: 'owner/isolated-tests', sync_branch: 'main', expectedSettingsVersion: 1 } })
    assert.equal(result.status, 200); assert.equal(result.body.settings_version, 2)
    assert.equal((await ownerRequest(projectPath() + '/settings/history')).body.length, 1)
    assert.equal((await ownerRequest(projectPath() + '/sync')).body.length, 1)
    assert.equal((await ownerRequest(projectPath() + '/sync/retry', { method: 'POST', body: {} })).status, 409)
    assert.equal((await ownerRequest(projectPath() + '/sync')).body[0].error, 'GITHUB_AUTHORIZATION_REQUIRED')
    assert.equal((await request(projectPath() + '/sync/retry', { method: 'POST', body: {}, cookie: outsider.cookie })).status, 403)
    assert.equal((await request(projectPath() + '/settings', { method: 'PATCH', body: { visibility: 'private' }, cookie: outsider.cookie })).status, 403)
    assert.equal((await ownerRequest(projectPath() + '/settings', { method: 'PATCH', body: { visibility: 'private', expectedSettingsVersion: 1 } })).status, 409)
    result = await request('/public/projects/' + projectId)
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body).sort(), ['id', 'name', 'yaml', 'revision', 'creator', 'visibility', 'category_icons'].sort())
    assert.deepEqual(result.body.category_icons, { sensores: 'sensor' })
    assert.equal((await request(projectPath(), { cookie: viewer.cookie })).status, 200)
    assert.equal((await request(projectPath(), { method: 'PUT', cookie: viewer.cookie, body: { yaml: JSON.stringify(document('Denied')), expectedRevision: 1 } })).status, 403)
    assert.equal((await request(projectPath() + '/share', { method: 'POST', body: {}, cookie: outsider.cookie })).status, 403)
  })

  await t.test('project members are explicit, owner-managed and independent of visibility', async () => {
    const path = projectPath() + '/members'
    for (const cookie of [viewer.cookie, outsider.cookie]) {
      assert.equal((await request(path, { cookie })).status, 403)
      assert.equal((await request(path, { cookie, method: 'PUT', body: { email: outsider.email, role: 'editor' } })).status, 403)
    }
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { email: owner.email, role: 'reader' } })).status, 400)
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { email: viewer.email, role: 'editor' } })).status, 400)
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { email: outsider.email, role: 'Admin' } })).status, 400)
    assert.equal((await ownerRequest(projectPath(), { method: 'PUT', body: { yaml: JSON.stringify(document('Denied')), expectedRevision: 1 }, cookie: outsider.cookie })).status, 403)
    assert.equal((await request(projectPath() + '/restore', { method: 'POST', cookie: outsider.cookie, body: { revision: 1, expectedRevision: 1 } })).status, 403)
    assert.equal((await request(projectPath() + '/analyses', { method: 'POST', cookie: outsider.cookie, body: {} })).status, 403)
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { email: outsider.email, role: 'reader' } })).status, 200)
    assert.equal((await request(projectPath(), { cookie: outsider.cookie })).body.permissions.canEdit, false)
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { email: outsider.email, role: 'editor' } })).status, 200)
    assert.equal((await request(projectPath(), { cookie: outsider.cookie })).body.permissions.canEdit, true)
    assert.equal((await ownerRequest(path)).body.length, 1)
    assert.equal((await ownerRequest(projectPath() + '/revisions')).body.length, 1)
    const privateId = (await ownerRequest('/projects', { method: 'POST', body: { name: 'Private collaboration ' + suffix } })).body.id
    const privatePath = '/projects/' + privateId
    // Admin can manage access; editors of a private project can save/restore, not manage members.
    assert.equal((await request(privatePath + '/members', { method: 'PUT', cookie: admin, body: { email: outsider.email, role: 'editor' } })).status, 200)
    assert.equal((await request(privatePath, { cookie: outsider.cookie })).body.permissions.canEdit, true)
    assert.equal((await request(privatePath + '/members', { cookie: outsider.cookie })).status, 403)
    assert.deepEqual((await request(privatePath, { method: 'PUT', cookie: outsider.cookie, body: { yaml: JSON.stringify(document('Collaborator edit')), expectedRevision: 1 } })).body, { revision: 2 })
    assert.deepEqual((await request(privatePath + '/restore', { method: 'POST', cookie: outsider.cookie, body: { revision: 1, expectedRevision: 2 } })).body, { revision: 3 })
    assert.equal((await ownerRequest(privatePath + '/members', { method: 'PUT', body: { email: outsider.email, role: 'reader' } })).status, 200)
    assert.equal((await request(privatePath, { cookie: outsider.cookie })).body.permissions.canEdit, false)
    assert.equal((await request(privatePath, { method: 'PUT', cookie: outsider.cookie, body: { yaml: JSON.stringify(document('Denied')), expectedRevision: 3 } })).status, 403)
    assert.equal((await ownerRequest(privatePath + '/members/' + outsider.id, { method: 'DELETE' })).status, 200)
    assert.equal((await request(privatePath, { cookie: outsider.cookie })).status, 403)
    assert.equal((await request('/projects', { cookie: outsider.cookie })).body.some(p => p.id === privateId), false)
  })

  await t.test('concurrent saves, stale revisions, restoration, history, diff and YAML export', async () => {
    let result = await request(projectPath(), { method: 'PUT', cookie: outsider.cookie, body: { yaml: JSON.stringify(document('Other editor')), expectedRevision: 1 } })
    assert.deepEqual(result.body, { revision: 2 })
    result = await ownerRequest(projectPath(), { method: 'PUT', body: { yaml: JSON.stringify(document('Stale')), expectedRevision: 1 } })
    assert.equal(result.status, 409); assert.equal(result.body.error, 'El proyecto cambió; recarga antes de guardar')
    const racers = await Promise.all(['First', 'Second'].map(name => ownerRequest(projectPath(), { method: 'PUT', body: { yaml: JSON.stringify(document(name)), expectedRevision: 2 } })))
    assert.deepEqual(racers.map(r => r.status).sort(), [200, 409])
    assert.equal((await ownerRequest(projectPath() + '/revisions')).body.length, 3)
    assert.equal((await ownerRequest(projectPath() + '/sync')).body.length, 3)
    result = await ownerRequest(projectPath() + '/diff?from=1&to=3'); assert.equal(result.status, 200); assert.match(result.body, /project.yaml/)
    result = await ownerRequest(projectPath() + '/revisions/1'); assert.match(result.headers.get('content-type'), /text\/yaml/)
    result = await ownerRequest(projectPath() + '/export'); assert.match(result.headers.get('content-disposition'), new RegExp(projectId + '\\.yaml'))
    result = await ownerRequest(projectPath() + '/restore', { method: 'POST', body: { revision: 1, expectedRevision: 3 } })
    assert.deepEqual(result.body, { revision: 4 })
    result = await ownerRequest(projectPath() + '/restore', { method: 'POST', body: { revision: 1, expectedRevision: 3 } })
    assert.equal(result.status, 409); assert.equal(result.body.error, 'El proyecto cambió; recarga antes de restaurar')
    assert.equal((await ownerRequest(projectPath() + '/revisions')).body.length, 4)
    assert.equal((await ownerRequest(projectPath() + '/sync')).body.length, 4)
  })

  await t.test('private share links, revocation and visibility changes preserve access boundaries', async () => {
    await ownerRequest(projectPath() + '/members/' + outsider.id, { method: 'DELETE' })
    assert.deepEqual((await ownerRequest(projectPath() + '/share', { method: 'POST', body: {} })).body, { path: '/?public=' + projectId })
    let result = await ownerRequest(projectPath() + '/settings', { method: 'PATCH', body: { visibility: 'private', sync_repository: 'owner/isolated-tests', expectedSettingsVersion: 2 } })
    assert.equal(result.body.settings_version, 3)
    result = await ownerRequest(projectPath() + '/share', { method: 'POST', body: {} })
    const token = new URL('http://local' + result.body.path).searchParams.get('share')
    assert.equal(token.length, 43)
    assert.equal((await request('/shared/' + token)).status, 200)
    await ownerRequest(projectPath() + '/members', { method: 'PUT', body: { email: viewer.email, role: 'reader' } })
    assert.equal((await request(projectPath(), { cookie: viewer.cookie })).status, 200)
    assert.equal((await request('/projects', { cookie: viewer.cookie })).body.some(p => p.id === projectId), true)
    assert.equal((await request(projectPath(), { method: 'PUT', cookie: viewer.cookie, body: { yaml: JSON.stringify(document('Denied')), expectedRevision: 4 } })).status, 403)
    await ownerRequest(projectPath() + '/members/' + viewer.id, { method: 'DELETE' })
    assert.equal((await request(projectPath(), { cookie: viewer.cookie })).status, 403)
    assert.equal((await request(projectPath(), { cookie: outsider.cookie })).status, 403)
    assert.equal((await request(projectPath() + '/share', { method: 'DELETE', cookie: outsider.cookie })).status, 403)
    assert.equal((await ownerRequest(projectPath() + '/share', { method: 'DELETE' })).status, 200)
    assert.equal((await request('/shared/' + token)).status, 404)
    const shared = await ownerRequest(projectPath() + '/share', { method: 'POST', body: {} })
    const secondToken = new URL('http://local' + shared.body.path).searchParams.get('share')
    result = await ownerRequest(projectPath() + '/settings', { method: 'PATCH', body: { visibility: 'public', sync_repository: 'owner/isolated-tests', expectedSettingsVersion: 3 } })
    assert.equal(result.body.settings_version, 4)
    assert.equal((await request('/shared/' + secondToken)).status, 404)
  })

  await t.test('blocks preserve versions, conflicts, category validation and logical deletion', async () => {
    assert.equal((await request('/blocks', { method: 'POST', cookie: viewer.cookie, body: { yaml: JSON.stringify(block) } })).status, 403)
    let result = await ownerRequest('/blocks', { method: 'POST', body: { yaml: JSON.stringify({ ...block, name: 'Block ' + suffix }) } })
    assert.equal(result.status, 201); blockId = result.body.id
    const path = '/blocks/' + blockId
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { yaml: JSON.stringify(block), expectedVersion: 0 } })).status, 400)
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { yaml: JSON.stringify({ ...block, category: 'nonexistent' }), expectedVersion: 1 } })).status, 400)
    result = await ownerRequest(path, { method: 'PUT', body: { yaml: JSON.stringify({ ...block, name: 'Updated ' + suffix }), expectedVersion: 1 } })
    assert.deepEqual(result.body, { version: 2 })
    assert.equal((await ownerRequest(path, { method: 'PUT', body: { yaml: JSON.stringify(block), expectedVersion: 1 } })).status, 409)
    assert.equal((await ownerRequest(path + '/versions')).body.length, 2)
    assert.match((await ownerRequest(path + '/diff?from=1&to=2')).body, /block.yaml/)
    assert.match((await ownerRequest(path + '/versions/1')).headers.get('content-type'), /text\/yaml/)
    assert.deepEqual((await ownerRequest(path + '/restore', { method: 'POST', body: { version: 1, expectedVersion: 2 } })).body, { version: 3 })
    assert.equal((await ownerRequest(path + '/restore', { method: 'POST', body: { version: 1, expectedVersion: 2 } })).status, 409)
    assert.equal((await ownerRequest(path + '/versions')).body.length, 3)
    assert.equal((await request(path, { method: 'DELETE', cookie: outsider.cookie })).status, 404)
    assert.equal((await ownerRequest(path, { method: 'DELETE' })).status, 200)
    assert.equal((await request(path, { method: 'DELETE', cookie: admin })).status, 404)
    assert.equal((await ownerRequest('/blocks')).body.some(b => b.id === blockId), false)
    assert.equal((await ownerRequest('/trash/block/' + blockId + '/restore', { method: 'POST' })).status, 200)
    assert.equal((await ownerRequest('/blocks')).body.some(b => b.id === blockId), true)
    assert.equal((await ownerRequest(path, { method: 'DELETE' })).status, 200)
  })

  await t.test('gallery image content requires ownership while creation/deletion require the original roles', async () => {
    const body = { name: 'Pixel ' + suffix, mime: 'image/png', data: png }
    assert.equal((await request('/images', { method: 'POST', cookie: viewer.cookie, body })).status, 403)
    assert.equal((await ownerRequest('/images', { method: 'POST', body: { ...body, data: 'invalid' } })).status, 400)
    const created = await ownerRequest('/images', { method: 'POST', body }); assert.equal(created.status, 201)
    assert.equal((await request('/images/' + created.body.id + '/content')).status, 404)
    const result = await ownerRequest('/images/' + created.body.id + '/content')
    assert.equal(result.status, 200); assert.deepEqual(result.body, Buffer.from(png, 'base64'))
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await request('/images')).status, 401)
    assert.equal((await ownerRequest('/images')).body.some(i => i.id === created.body.id), true)
    assert.equal((await request('/images/' + created.body.id, { method: 'DELETE', cookie: outsider.cookie })).status, 404)
    assert.equal((await ownerRequest('/images/' + created.body.id, { method: 'DELETE' })).status, 200)
    assert.equal((await request('/images/' + created.body.id, { method: 'DELETE', cookie: admin })).status, 404)
    assert.equal((await ownerRequest('/images')).body.some(i => i.id === created.body.id), false)
    assert.equal((await request('/images/' + created.body.id + '/content')).status, 404)
    assert.equal((await ownerRequest('/validate', { method: 'POST', body: { kind: 'project', yaml: JSON.stringify(document('Valid')) } })).status, 200)
    assert.equal((await ownerRequest('/validate', { method: 'POST', body: { kind: 'block', yaml: JSON.stringify(block) } })).status, 200)
    assert.equal((await ownerRequest('/validate', { method: 'POST', body: { kind: 'other', yaml: '{}' } })).status, 400)
  })

  await t.test('real PostgreSQL rollback covers project update, history, queue, sharing and migrated images', { skip: !databaseUrl }, async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl })
    try {
      const q = (sql, args = []) => pool.query(sql, args)
      const transaction = createTransaction(pool)
      const id = (await ownerRequest('/projects', { method: 'POST', body: { yaml: JSON.stringify(document('Rollback ' + suffix)) } })).body.id
      await ownerRequest('/projects/' + id + '/settings', { method: 'PATCH', body: { visibility: 'private', sync_repository: 'owner/rollback', expectedSettingsVersion: 1 } })
      await ownerRequest('/projects/' + id + '/share', { method: 'POST', body: {} })
      const legacy = document('Legacy ' + suffix); legacy.nodes[0] = { ...legacy.nodes[0], block: { ...block, image: 'data:image/png;base64,' + png } }
      await q('UPDATE project_revisions SET yaml=$2 WHERE project_id=$1 AND revision=1', [id, JSON.stringify(legacy)])
      async function snapshot() {
        return {
          project: (await q('SELECT name,yaml,revision,visibility,settings_version,sync_repository,sync_branch,share_token FROM projects WHERE id=$1', [id])).rows,
          revisions: (await q('SELECT revision,yaml,summary FROM project_revisions WHERE project_id=$1 ORDER BY revision', [id])).rows,
          jobs: (await q('SELECT revision,status,target_repository,target_branch FROM sync_jobs WHERE record_id=$1 ORDER BY id', [id])).rows,
          settings: (await q('SELECT before,after FROM project_settings_history WHERE project_id=$1 ORDER BY id', [id])).rows,
          images: (await q("SELECT id FROM images WHERE created_by IS NULL AND name LIKE 'Imagen migrada%' ORDER BY id")).rows,
        }
      }
      const before = await snapshot()
      const service = createProjectService({ projects: createProjectRepository(q), transaction, categoryIcons: yaml => projectCategoryIcons(yaml, q), replaceEmbeddedImages,
        enqueue: async (...args) => { await enqueue(...args); throw Error('Injected queue failure') },
      })
      await assert.rejects(service.save(id, owner, { yaml: JSON.stringify(document('Must roll back')), expectedRevision: 1 }), /Injected queue failure/)
      assert.deepEqual(await snapshot(), before)
      await assert.rejects(service.restore(id, owner, { revision: 1, expectedRevision: 1 }), /Injected queue failure/)
      assert.deepEqual(await snapshot(), before)
      await assert.rejects(service.settings(id, owner, { visibility: 'public', sync_repository: 'other/target', expectedSettingsVersion: 2 }), /Injected queue failure/)
      assert.deepEqual(await snapshot(), before)
      // A save that began before a revoke must reread membership after obtaining the lock.
      await ownerRequest('/projects/' + id + '/members', { method: 'PUT', body: { email: outsider.email, role: 'editor' } })
      const revoker = await pool.connect()
      let signalLock
      const lockAttempted = new Promise(resolve => { signalLock = resolve })
      const repo = createProjectRepository(q)
      const lockedService = createProjectService({ projects: { ...repo, find: (...args) => { if (args[3]) signalLock(); return repo.find(...args) } }, transaction, enqueue, replaceEmbeddedImages })
      try {
        await revoker.query('BEGIN')
        await revoker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [id])
        await revoker.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [id, outsider.id])
        const deniedSave = assert.rejects(lockedService.save(id, outsider, { yaml: JSON.stringify(document('Revoked')), expectedRevision: 1 }), { status: 403 })
        await lockAttempted
        await revoker.query('COMMIT')
        await deniedSave
        assert.deepEqual(await snapshot(), before)
      } finally { await revoker.query('ROLLBACK'); revoker.release() }
      // A failed block-version insertion also rolls back metadata and embedded-image migration.
      const created = await ownerRequest('/blocks', { method: 'POST', body: { yaml: JSON.stringify({ ...block, name: 'Rollback block ' + suffix }) } })
      const blockId = created.body.id, repository = createBlockRepository(q)
      await q('UPDATE block_versions SET yaml=$2 WHERE block_id=$1 AND version=1', [blockId, JSON.stringify(legacy.nodes[0].block)])
      const blockBefore = (await q('SELECT name,latest_version,category_slug FROM blocks WHERE id=$1', [blockId])).rows
      const blockService = createBlockService({ blocks: { ...repository, addVersion: async (...args) => { await repository.addVersion(...args); throw Error('Injected version failure') } }, transaction, validateCategory, replaceEmbeddedImages })
      for (const operation of ['save', 'restore']) {
        await assert.rejects(blockService[operation](blockId, owner, { yaml: JSON.stringify(block), version: 1, expectedVersion: 1 }), /Injected version failure/)
        assert.deepEqual((await q('SELECT name,latest_version,category_slug FROM blocks WHERE id=$1', [blockId])).rows, blockBefore)
        assert.equal((await repository.versions(blockId)).length, 1)
        assert.deepEqual((await snapshot()).images, before.images)
      }
    } finally { await pool.end() }
  })

  await t.test('project logical deletion does not expose deleted private or public projects', async () => {
    assert.equal((await request(projectPath(), { method: 'DELETE', cookie: outsider.cookie })).status, 404)
    assert.equal((await request(projectPath(), { method: 'DELETE', cookie: viewer.cookie })).status, 403)
    assert.equal((await ownerRequest(projectPath(), { method: 'DELETE' })).status, 200)
    assert.equal((await request(projectPath(), { method: 'DELETE', cookie: admin })).status, 404)
    assert.equal((await request(projectPath(), { cookie: admin })).status, 404)
    assert.equal((await request('/public/projects/' + projectId)).status, 404)
    assert.equal((await request('/projects', { cookie: admin })).body.some(p => p.id === projectId), false)
  })
})
