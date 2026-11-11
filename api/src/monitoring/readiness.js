import { performance } from 'node:perf_hooks'
import { schemaVersion } from '../database/access.js'
import { validateImageStorage } from '../images/quotas.js'
import { validateDocumentStorage } from '../document-storage/config.js'
import { validateTotalStorage } from '../storage-total/config.js'
import { projectFavoriteStorageTrigger, totalStorageTables } from '../storage-total/migration.js'

export const readinessQuery = `SELECT value,
  (SELECT value FROM settings WHERE key='github_user_schema_version')='2'::jsonb
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='sync_jobs'::regclass AND tgname='sugar_sync_authorization' AND tgenabled='O') AS github_ready,
  (SELECT value FROM image_storage_config WHERE id=true) AS image_limits,
  (SELECT version FROM image_storage_config WHERE id=true) AS image_version,
  (SELECT value FROM document_storage_config WHERE id=true) AS document_limits,
  (SELECT version FROM document_storage_config WHERE id=true) AS document_version,
  (SELECT value FROM total_storage_config WHERE id=true) AS total_limits,
  (SELECT version FROM total_storage_config WHERE id=true) AS total_version,
  EXISTS(SELECT 1 FROM total_storage_usage WHERE id=true) AS total_usage_ready,
  (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relnamespace=current_schema()::regnamespace
      AND (t.tgname LIKE 'sugar\\_total\\_storage\\_%' OR (c.relname='project_favorites' AND t.tgname='${projectFavoriteStorageTrigger}'))
      AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled='O') AS total_triggers,
  EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='blocks'::regclass AND attname='catalog_preview'
    AND atttypid='jsonb'::regtype AND NOT attisdropped) AS block_catalog_ready,
  EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='ai_calls'::regclass AND attname='storage_bytes'
    AND atttypid='int8'::regtype AND attnotnull AND NOT attisdropped) AS ai_storage_ready,
  EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='user_sessions'::regclass AND attname='mfa_verified'
    AND atttypid='bool'::regtype AND attnotnull AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='user_sessions'::regclass AND tgname='sugar_mfa_session_guard' AND tgenabled='O') AS mfa_sessions_ready
  FROM settings WHERE key='schema_version'`
export const databaseProbe = q => async () => {
  const result = await q({ text: readinessQuery, query_timeout: 1000 }), row = result.rows?.[0]
  if (row?.value !== schemaVersion || !Number.isSafeInteger(row.image_version) || row.image_version < 1 || !Number.isSafeInteger(row.document_version) || row.document_version < 1 || !Number.isSafeInteger(row.total_version) || row.total_version < 1 || row.total_usage_ready !== true || row.total_triggers !== totalStorageTables.length || row.block_catalog_ready !== true || row.ai_storage_ready !== true || row.mfa_sessions_ready !== true || row.github_ready !== true) return false
  try { validateImageStorage(row.image_limits); validateDocumentStorage(row.document_limits); validateTotalStorage(row.total_limits); return true } catch { return false }
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
