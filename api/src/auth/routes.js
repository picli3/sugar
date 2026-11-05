import { asyncRoute, noStore } from '../shared/http.js'
import { sessionLifetime } from './service.js'

export function registerAuthRoutes(app, { auth, sessionSecure, loginGate, mfaGate }) {
  const complete = (req, res, result) => {
    res.locals.auditActor = result.user.id
    res.cookie('session', result.token, { httpOnly: true, sameSite: 'strict', secure: sessionSecure || req.secure, maxAge: sessionLifetime * 1000, path: '/' })
    res.json(result.user)
  }
  app.post('/api/login/mfa/recover', noStore, mfaGate, asyncRoute(async (req, res) => complete(req, res, await auth.recoverMfa(req.body))))
  app.post('/api/login/mfa', noStore, mfaGate, asyncRoute(async (req, res) => complete(req, res, await auth.completeMfa(req.body))))
  app.post('/api/login', noStore, loginGate, asyncRoute(async (req, res) => {
    const result = await auth.login(req.body)
    if (result.mfaRequired) { res.clearCookie('session', { path: '/' }); return res.status(202).json(result) }
    complete(req, res, result)
  }))
  app.post('/api/logout', noStore, asyncRoute(async (req, res) => {
    await auth.logout(req.cookies.session)
    res.clearCookie('session', { path: '/' }); res.json({ ok: true })
  }))
}
export function registerSessionRoutes(app, auth) {
  app.get('/api/me/sessions', noStore, asyncRoute(async (req, res) => res.json(await auth.listSessions(req.user, req.sessionId))))
  app.post('/api/me/sessions/revoke-others', noStore, asyncRoute(async (req, res) => { await auth.revokeOthers(req.user, req.sessionId); res.json({ ok: true }) }))
  app.delete('/api/me/sessions/:id', noStore, asyncRoute(async (req, res) => {
    await auth.revokeSession(req.user, req.params.id)
    if (req.params.id === req.sessionId) res.clearCookie('session', { path: '/' })
    res.json({ ok: true })
  }))
}
export function authenticate(auth) {
  return asyncRoute(async (req, res, next) => {
    try {
      const session = await auth.authenticateSession(req.cookies.session)
      req.user = session.user; req.sessionId = session.sessionId
      next()
    } catch (e) {
      if (e.status === 401) { res.clearCookie('session', { path: '/' }); res.set('Cache-Control', 'private, no-store') }
      throw e
    }
  })
}
