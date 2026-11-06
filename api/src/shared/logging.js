import { githubFailureCodes } from '../github-link/protocol.js'
// Never serialize arbitrary Error objects, provider bodies, messages or headers.
export function failureCode(error) {
  const code = error?.code
  if (githubFailureCodes.has(code)) return code
  if (['23505','22P02','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','BOOTSTRAP_CONFIG','SECRET_CONFIG','DATABASE_CONFIG'].includes(code)) return code
  if (typeof code === 'string' && /^GITHUB_(READ|WRITE)_[1-5]\d\d$/.test(code)) return code
  return 'UNEXPECTED_ERROR'
}
const events = new Set(['HTTP request failed','GitHub sync failed','GitHub worker failed','GitHub retry failed','Database startup retry','API startup failed','Database migration failed','Database pool error','Audit output failed'])
// The optional request ID (a server-generated UUID) correlates a failure with its audit event and X-Request-Id.
export function reportFailure(event, error, requestId) {
  const request = typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId) ? ` request=${requestId}` : ''
  console.error(`${events.has(event) ? event : 'Application error'}: ${failureCode(error)}${request}`)
}
