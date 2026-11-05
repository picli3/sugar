import { validateDocumentStorage } from '../document-storage/config.js'
import { analysisStorageBytes } from '../document-storage/repository.js'

export const aiResponseBytes = 1024 * 1024
const usageAllowance = 256
const fail = (status, message) => { throw Object.assign(Error(message), { status }) }
export function createAiStorage(repository) {
  return {
    async reserve(tx, { id, userId, projectId, plan }) {
      await repository.lock(tx)
      if (projectId && !plan) fail(400, 'aiInvalidRequest')
      if (plan) {
        const row = (await tx(`SELECT ${analysisStorageBytes('a')} AS bytes FROM jsonb_populate_record(NULL::project_analyses,$1::jsonb) a`, [JSON.stringify(plan)])).rows[0]
        await tx('UPDATE ai_calls SET storage_bytes=$2 WHERE id=$1', [id, BigInt(row.bytes) + BigInt(aiResponseBytes + usageAllowance)])
      }
      const configuration = await repository.config(tx)
      if (!Number.isSafeInteger(configuration?.version) || configuration.version < 1) fail(503, 'aiStorageUnavailable')
      let limits
      try { limits = validateDocumentStorage(configuration?.value) } catch { fail(503, 'aiStorageUnavailable') }
      const owner = projectId ? (await tx('SELECT created_by FROM projects WHERE id=$1', [projectId])).rows[0]?.created_by : userId
      const global = await repository.usage(null, tx)
      if (BigInt(global.bytes) > BigInt(limits.platformBytes)) fail(409, 'aiStorageQuota')
      if (owner) {
        const personal = await repository.usage(owner, tx)
        if (BigInt(personal.bytes) > BigInt(limits.userBytes)) fail(409, 'aiStorageQuota')
      }
    },
    async finish(tx, call, save) {
      await repository.lock(tx)
      const analysisId = await save(tx)
      if (analysisId) {
        const row = (await tx(`SELECT ${analysisStorageBytes('a')} AS bytes FROM project_analyses a WHERE id=$1`, [analysisId])).rows[0]
        if (!row || BigInt(row.bytes) > BigInt(call.storage_bytes)) fail(502, 'aiProviderTooLarge')
      }
      await tx('UPDATE ai_calls SET storage_bytes=0 WHERE id=$1', [call.id])
      return analysisId
    },
    async release(tx, id) { await repository.lock(tx); await tx('UPDATE ai_calls SET storage_bytes=0 WHERE id=$1', [id]) },
  }
}
