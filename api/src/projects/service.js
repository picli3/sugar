import crypto from 'node:crypto'
import { documentDiff } from '../shared/document-diff.js'
import { error, requiredText } from '../shared/http.js'
import { requireEdit, requireProjectAccess, projectPermissions } from '../auth/policies.js'
import { normalizeColorLiterals, stringify, validateProject, revisionSummary } from '../model.js'
import { repositorySettings } from './validation.js'
import { pageInput, pageResult, revisionPageInput, revisionPageResult, bigintPageInput, identifierPageInput, identifierPageResult } from '../shared/pagination.js'

export function createProjectService({ projects, transaction, storage, enqueue, categoryIcons, replaceEmbeddedImages, attachImages = async () => {} }) {
  const get = async (id, user, options, tx, lock = false) => {
    const project = requireProjectAccess(await projects.find(id, user.id, tx, lock), user, options)
    return { ...project, permissions: projectPermissions(project, user) }
  }
  const publicResult = async project => {
    const { id, name, yaml, revision, creator, visibility } = project
    return { id, name, yaml, revision, creator, visibility, category_icons: await categoryIcons(yaml) }
  }
  const write = (id, action) => storage ? storage.write('project', id, action) : transaction(action)
  return {
    get,
    async icons(id, user, query = {}) {
      const project = await get(id, user), base = query.baseRevision
      if (Object.keys(query).some(key => key !== 'baseRevision') || (base !== undefined && (typeof base !== 'string' || !/^[1-9]\d{0,9}$/.test(base) || Number(base) > 2147483647))) error(400, 'Revisión de contexto inválida / Invalid context revision')
      if (base !== undefined && Number(base) !== project.revision) error(409, 'El proyecto cambió; recarga para actualizar sus iconos / Project changed; reload to update its icons')
      return categoryIcons(project.yaml)
    },
    list: user => projects.list(user),
    async page(user, query) {
      const input = pageInput(query)
      const page = await projects.page(user, input)
      return pageResult(page.rows, input.limit, item => item, page.more)
    },
    async public(id) {
      const project = await projects.public(id)
      if (!project) error(404, 'Proyecto público no encontrado')
      return publicResult(project)
    },
    async shared(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) error(404, 'Enlace no encontrado')
      const project = await projects.shared(token)
      if (!project) error(404, 'Enlace no encontrado')
      return publicResult(project)
    },
    async members(id, user) { await get(id, user, { ownerOnly: true }); return projects.members(id) },
    async membersPage(id, user, query) {
      await get(id, user, { ownerOnly: true })
      const input = identifierPageInput(query), page = await projects.membersPage(id, input)
      return identifierPageResult(page.rows, input.limit, ({ id, ...member }) => member, page.more)
    },
    async setMember(id, user, input) {
      await get(id, user, { ownerOnly: true })
      const email = requiredText(input.email, 'Email').toLowerCase(), role = input.role
      if (!['editor', 'reader'].includes(role)) error(400, 'Permiso de proyecto inválido')
      return transaction(async tx => {
        const current = await get(id, user, { ownerOnly: true }, tx, true)
        const account = await projects.memberAccount(email, tx)
        if (!account) error(404, 'Usuario activo no encontrado')
        if (account.id === current.created_by) error(400, 'El propietario mantiene acceso al proyecto')
        if (role === 'editor' && account.role === 'view') error(400, 'Los usuarios con rol view solo pueden ser lectores')
        await projects.setMember(id, account.id, role, tx)
        return { user_id: account.id, email: account.email, role, active: account.active }
      })
    },
    async removeMember(id, user, memberId) {
      await get(id, user, { ownerOnly: true })
      await transaction(async tx => {
        const current = await get(id, user, { ownerOnly: true }, tx, true)
        if (memberId === current.created_by) error(400, 'El propietario mantiene acceso al proyecto')
        await projects.removeMember(id, memberId, tx)
      })
    },
    async create(user, input) {
      requireEdit(user)
      const yaml = normalizeColorLiterals(requiredText(input.yaml || stringify({ name: input.name || 'Nuevo proyecto', nodes: [], edges: [] }), 'YAML'))
      const project = validateProject(yaml), id = crypto.randomUUID(), summary = revisionSummary(input.summary, 'Proyecto creado')
      await write(id, async tx => {
        await projects.create(id, project.name, yaml, user.id, tx)
        await attachImages(yaml, 'project', id, user, tx)
        await projects.addRevision(id, 1, yaml, user.id, summary, tx)
      })
      return { id, revision: 1 }
    },
    async settings(id, user, input) {
      const current = await get(id, user, { ownerOnly: true })
      const visibility = input.visibility
      if (!['public', 'private'].includes(visibility)) error(400, 'Visibilidad inválida')
      const { repository, branch } = repositorySettings(input)
      const expected = Number(input.expectedSettingsVersion)
      if (!Number.isInteger(expected) || expected < 1) error(400, 'Versión de configuración inválida')
      const before = { visibility: current.visibility, sync_repository: current.sync_repository, sync_branch: current.sync_branch }
      const after = { visibility, sync_repository: repository, sync_branch: branch }
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const changedTarget = repository !== current.sync_repository || branch !== current.sync_branch
        const mutate = repository && changedTarget ? action => write(id, action) : transaction
        await mutate(async tx => {
          await get(id, user, { ownerOnly: true }, tx, true)
          const saved = await projects.settings(id, expected, visibility, repository, branch, tx)
          if (!saved) error(409, 'La configuración cambió; recarga antes de guardar')
          await projects.addSettingsHistory(id, user.id, before, after, tx)
          if (changedTarget) await projects.skipPendingSync(id, tx)
          if (repository && changedTarget) await enqueue('project', id, saved.revision, saved.yaml, tx, { repository, branch })
        })
      }
      return get(id, user)
    },
    async settingsHistory(id, user) { await get(id, user); return projects.settingsHistory(id) },
    async settingsHistoryPage(id, user, query) {
      requireProjectAccess(await projects.access(id, user.id), user)
      const input = bigintPageInput(query)
      const page = await projects.settingsHistoryPage(id, input)
      return identifierPageResult(page.rows, input.limit, item => item, page.more)
    },
    async share(id, user) {
      const project = await get(id, user, { ownerOnly: true })
      if (project.visibility === 'public') return { path: `/?public=${project.id}` }
      const link = await projects.share(project.id, crypto.randomBytes(32).toString('base64url'))
      return { path: `/?share=${link.share_token}`, expiresAt: link.share_expires_at }
    },
    async revokeShare(id, user) { await get(id, user, { ownerOnly: true }); await projects.revokeShare(id) },
    async save(id, user, input) {
      await get(id, user, { edit: true })
      const yaml = normalizeColorLiterals(requiredText(input.yaml, 'YAML')), project = validateProject(yaml), expected = Number(input.expectedRevision)
      if (!Number.isInteger(expected) || expected < 1) error(400, 'Revisión esperada inválida')
      const summary = revisionSummary(input.summary, 'Proyecto actualizado')
      const revision = await write(id, async tx => {
        const current = await get(id, user, { edit: true }, tx, true)
        const saved = await projects.save(id, expected, project.name, yaml, tx)
        if (!saved) error(409, 'El proyecto cambió; recarga antes de guardar')
        const revision = saved.revision
        await attachImages(yaml, 'project', id, user, tx)
        await projects.addRevision(id, revision, yaml, user.id, summary, tx)
        if (current.sync_repository) await enqueue('project', id, revision, yaml, tx, { repository: current.sync_repository, branch: current.sync_branch })
        return revision
      })
      return { revision }
    },
    async revisions(id, user) { await get(id, user); return projects.revisions(id) },
    async revisionsPage(id, user, query) {
      requireProjectAccess(await projects.access(id, user.id), user)
      const input = revisionPageInput(query)
      const page = await projects.revisionsPage(id, input)
      return revisionPageResult(page.rows, input.limit, 'revision', page.more)
    },
    async revision(id, user, revision) {
      await get(id, user)
      const saved = await projects.revision(id, revision)
      if (!saved) error(404, 'Revisión no encontrada')
      return saved.yaml
    },
    async diff(id, user, input) {
      await get(id, user)
      const a = Number(input.from), b = Number(input.to)
      if (!Number.isInteger(a) || !Number.isInteger(b)) error(400, 'Selecciona dos revisiones')
      const rows = await projects.comparison(id, a, b)
      const one = rows.find(r => r.revision === a), two = rows.find(r => r.revision === b)
      if (!one || !two) error(404, 'Revisión no encontrada')
      return documentDiff('project.yaml', one.yaml, two.yaml, `revision ${a}`, `revision ${b}`)
    },
    async restore(id, user, input) {
      await get(id, user, { edit: true })
      const wanted = Number(input.revision), expected = Number(input.expectedRevision)
      if (!Number.isInteger(wanted) || !Number.isInteger(expected)) error(400, 'Revisión inválida')
      const source = await projects.revision(id, wanted)
      if (!source) error(404, 'Revisión no encontrada')
      const revision = await write(id, async tx => {
        const current = await get(id, user, { edit: true }, tx, true)
        const yaml = normalizeColorLiterals(await replaceEmbeddedImages(source.yaml, 'project', tx, { ownerId: user.id }))
        const doc = validateProject(yaml)
        const saved = await projects.save(id, expected, doc.name, yaml, tx)
        if (!saved) error(409, 'El proyecto cambió; recarga antes de restaurar')
        const revision = saved.revision
        await attachImages(yaml, 'project', id, user, tx)
        await projects.addRevision(id, revision, yaml, user.id, `Restaurada revisión ${wanted}`, tx)
        if (current.sync_repository) await enqueue('project', id, revision, yaml, tx, { repository: current.sync_repository, branch: current.sync_branch })
        return revision
      })
      return { revision }
    },
  }
}
