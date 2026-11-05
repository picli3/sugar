import { performance } from 'node:perf_hooks'
import { schemaVersion } from '../database/access.js'
import { validateImageStorage } from '../images/quotas.js'
import { validateDocumentStorage } from '../document-storage/config.js'

export const readinessQuery = `SELECT value,
  (SELECT value FROM image_storage_config WHERE id=true) AS image_limits,
  (SELECT version FROM image_storage_config WHERE id=true) AS image_version,
  (SELECT value FROM document_storage_config WHERE id=true) AS document_limits,
  (SELECT version FROM document_storage_config WHERE id=true) AS document_version
  FROM settings WHERE key='schema_version'`
export const databaseProbe = q => async () => {
  const result = await q({ text: readinessQuery, query_timeout: 1000 }), row = result.rows?.[0]
  if (row?.value !== schemaVersion || !Number.isSafeInteger(row.image_version) || row.image_version < 1 || !Number.isSafeInteger(row.document_version) || row.document_version < 1) return false
  try { validateImageStorage(row.image_limits); validateDocumentStorage(row.document_limits); return true } catch { return false }
}

// A timeout answers the HTTP caller but retains the in-flight guard until the
// underlying operation settles: repeated polls cannot enqueue unlimited SQL.
export function createReadiness({ probe, timeoutMs = 1500, cacheMs = 1000, clock = () => performance.now() }) {
  let active = null, cached = null
  return function check() {
    if (active) return active.response
    if (cached && clock() - cached.at < cacheMs) return Promise.resolve(cached.ok)
    let resolve
    const state = { response: new Promise(done => { resolve = done }), finished: false }
    active = state
    const finish = ok => {
      if (state.finished) return
      state.finished = true
      clearTimeout(timer)
      cached = { ok, at: clock() }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    Promise.resolve().then(probe).then(value => finish(value === true), () => finish(false)).finally(() => {
      if (active === state) active = null
    })
    return state.response
  }
}
