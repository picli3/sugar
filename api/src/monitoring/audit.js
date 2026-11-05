import { reportFailure } from '../shared/logging.js'

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const identity = value => typeof value === 'string' && new RegExp(`^${uuid}$`).test(value) ? value : null
const rules = [
  ['POST', '/login/mfa/recover', 'auth.mfa_recover'], ['POST', '/login/mfa', 'auth.mfa_verify'],
  ['POST', '/me/mfa/enroll', 'auth.mfa_enroll'], ['POST', '/me/mfa/confirm', 'auth.mfa_confirm'],
  ['POST', '/me/mfa/recovery-codes', 'auth.mfa_recovery_regenerate'], ['POST', '/me/mfa/disable', 'auth.mfa_disable'],
  ['POST', '/login', 'auth.login'], ['POST', '/logout', 'auth.logout'],
  ['POST', '/registration/request', 'auth.registration_request'], ['POST', '/registration/verify', 'auth.registration_verify'],
  ['POST', '/recovery/request', 'auth.recovery_request'], ['POST', '/recovery/reset', 'auth.password_reset'],
  ['POST', '/recovery/confirm-email', 'auth.email_confirm'], ['POST', '/me/email', 'auth.email_request'],
  ['PUT', '/mail', 'mail.configure'], ['POST', '/mail/test', 'mail.connection_test'],
  ['POST', '/me/password', 'auth.password_change'],
  ['POST', '/me/sessions/revoke-others', 'auth.sessions_revoke'],
  ['DELETE', `/me/sessions/(${uuid})`, 'auth.session_revoke'],
  ['POST', '/users', 'user.create'], ['PATCH', `/users/(${uuid})`, 'user.update'], ['DELETE', `/users/(${uuid})`, 'user.archive'],
  ['PUT', '/ai', 'ai.configure'], ['PUT', '/ai/quotas', 'ai.quota_configure'], ['POST', '/ai/test', 'ai.connection_test'],
  ['PATCH', `/projects/(${uuid})/settings`, 'project.settings'],
  ['POST', `/projects/(${uuid})/share`, 'project.share_create'], ['DELETE', `/projects/(${uuid})/share`, 'project.share_revoke'],
  ['PUT', `/projects/(${uuid})/members`, 'project.members_update'], ['DELETE', `/projects/(${uuid})/members/${uuid}`, 'project.member_remove'],
  ['DELETE', `/projects/(${uuid})`, 'project.archive'], ['DELETE', `/blocks/(${uuid})`, 'block.archive'], ['DELETE', `/images/(${uuid})`, 'image.archive'],
].map(([method, path, operation]) => ({ method, path: new RegExp(`^${path}/?$`), operation }))

// HTTP outcome audit only. Never serialize request/response objects or error data.
export function securityAudit({ write = event => console.log(JSON.stringify(event)), now = () => new Date().toISOString() } = {}) {
  return (req, res, next) => {
    let path
    try { path = decodeURIComponent(req.path).toLowerCase() } catch { return next() }
    const rule = rules.find(rule => rule.method === req.method && rule.path.test(path))
    if (rule) {
      const resource = rule.operation.startsWith('auth.') ? undefined : rule.path.exec(path)[1]
      let recorded = false
      const record = aborted => {
        if (recorded) return
        recorded = true
        const status = aborted ? null : res.statusCode
        const event = {
          schema: 'sugar.audit.v1', at: now(), actor: identity(res.locals.auditActor) || identity(req.user?.id),
          operation: rule.operation, result: aborted ? 'aborted' : status >= 500 ? 'error' : status >= 400 ? 'denied' : 'success', status,
          ...(resource ? { resource } : {}),
        }
        const failed = () => reportFailure('Audit output failed', {})
        try { Promise.resolve(write(event)).catch(failed) } catch { failed() }
      }
      res.once('finish', () => record(false))
      res.once('close', () => { if (!res.writableFinished) record(true) })
    }
    next()
  }
}
