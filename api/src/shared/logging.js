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
export function reportFailure(event, error) { console.error(`${events.has(event) ? event : 'Application error'}: ${failureCode(error)}`) }
