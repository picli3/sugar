import { error } from '../shared/http.js'
import { validateDocumentStorage } from './config.js'
export function createDocumentStorage({ repository, transaction }) {
  const lock = repository.lock, usage = repository.usage
  const config = async tx => {
    const row = await repository.config(tx)
    if (!row) error(503, 'Migra la configuración documental / Migrate document configuration')
    return { ...row.value, version: row.version }
  }
  const configuration = async () => { const [limits, used] = await Promise.all([config(), usage()]); return { ...limits, usage: used } }
  const labels = { userProjects: 'proyectos de cuenta / account projects', platformProjects: 'proyectos de plataforma / platform projects', userBlocks: 'bloques de cuenta / account blocks', platformBlocks: 'bloques de plataforma / platform blocks', projectRevisions: 'revisiones por proyecto / revisions per project', blockVersions: 'versiones por bloque / versions per block', userRevisions: 'historial de cuenta / account history', platformRevisions: 'historial de plataforma / platform history', userBytes: 'bytes de cuenta / account bytes', platformBytes: 'bytes de plataforma / platform bytes' }
  const exceeded = key => error(409, `Cuota documental agotada (${labels[key]}); contacta al administrador. Los archivados e historiales conservan capacidad / Document quota exhausted; contact the administrator. Archived records and history retain capacity`)
  async function enforce(kind, id, tx) {
    const limits = await config(tx), project = kind === 'project'
    const target = await repository.target(kind, id, tx)
    if (!target) throw Error('Document quota target missing')
    const revisions = target.revisions
    const versionKey = project ? 'projectRevisions' : 'blockVersions'
    if (BigInt(revisions) > BigInt(limits[versionKey])) exceeded(versionKey)
    const platformUsage = await usage(null, tx)
    for (const [field, key] of Object.entries({ projects: 'platformProjects', blocks: 'platformBlocks', revisions: 'platformRevisions', bytes: 'platformBytes' })) if (BigInt(platformUsage[field]) > BigInt(limits[key])) exceeded(key)
    if (target.ownerId) {
      const personal = await usage(target.ownerId, tx)
      for (const [field, key] of Object.entries({ projects: 'userProjects', blocks: 'userBlocks', revisions: 'userRevisions', bytes: 'userBytes' })) if (BigInt(personal[field]) > BigInt(limits[key])) exceeded(key)
    }
  }
  return {
    configuration,
    async summary(userId) {
      const [limits, used] = await Promise.all([config(), usage(userId)])
      return { limits: Object.fromEntries(Object.entries(limits).filter(([key]) => key.startsWith('user') || ['projectRevisions','blockVersions'].includes(key))), usage: used }
    },
    async configure(input) {
      const limits = validateDocumentStorage(input)
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) error(400, 'Versión de cuota inválida / Invalid quota version')
      await transaction(async tx => {
        await lock(tx)
        const saved = await repository.configure(limits, input.expectedVersion, tx)
        if (!saved) error(409, 'La cuota cambió; recarga antes de guardar / Quota changed; reload before saving')
      })
      return configuration()
    },
    async write(kind, id, action) {
      if (!['project','block'].includes(kind)) throw Error('Invalid document storage kind')
      return transaction(async tx => { await lock(tx); const result = await action(tx); await enforce(kind, id, tx); return result })
    },
    async metadata(action) {
      return transaction(async tx => {
        await lock(tx)
        const { result, ownerId } = await action(tx), limits = await config(tx)
        if (BigInt((await usage(null, tx)).bytes) > BigInt(limits.platformBytes)) exceeded('platformBytes')
        if (ownerId && BigInt((await usage(ownerId, tx)).bytes) > BigInt(limits.userBytes)) exceeded('userBytes')
        return result
      })
    },
  }
}
