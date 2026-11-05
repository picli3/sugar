import { error } from '../shared/http.js'
import { validateTotalStorage } from './config.js'

export function createTotalStorage({ q, transaction }) {
  const configuration = async () => {
    const [config, measured] = await Promise.all([
      q('SELECT value,version FROM total_storage_config WHERE id=true'),
      q('SELECT images,documents,ai,sync,categories,config FROM total_storage_usage WHERE id=true'),
    ])
    if (!config.rows[0]) error(503, 'Migra la cuota global / Migrate global quota')
    const usage = measured.rows[0]
    if (!usage) error(503, 'Migra los contadores de almacenamiento / Migrate storage counters')
    return { ...config.rows[0].value, version: config.rows[0].version,
      usage: { ...usage, total: Object.values(usage).reduce((sum, bytes) => sum + BigInt(bytes), 0n).toString() } }
  }
  return {
    configuration,
    async configure(input) {
      const limits = validateTotalStorage(input)
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) error(400, 'Versión de cuota inválida / Invalid quota version')
      await transaction(async tx => {
        await tx("SELECT pg_advisory_xact_lock(hashtext('sugar:total-storage'))")
        const changed = await tx('UPDATE total_storage_config SET value=$1::jsonb,version=version+1 WHERE id=true AND version=$2 RETURNING version', [JSON.stringify(limits), input.expectedVersion])
        if (!changed.rowCount) error(409, 'La cuota cambió; recarga antes de guardar / Quota changed; reload before saving')
      })
      return configuration()
    },
  }
}
