import { sessionLifetime } from '../auth/service.js'
import { asyncRoute, noStore } from '../shared/http.js'

export function registerMfaRoutes(app, { mfa, gate, auth, sessionSecure }) {
  app.get('/api/me/mfa', noStore, asyncRoute(async (req, res) => res.json(await mfa.status(req.user))))
  for (const [path, method] of [['enroll','begin'],['confirm','confirm'],['recovery-codes','regenerate'],['disable','disable']]) {
    app.post('/api/me/mfa/' + path, noStore, gate, asyncRoute(async (req, res) => {
      const { session, ...result } = await mfa[method](req.user, req.sessionId, req.body)
      if (session) res.cookie('session', auth.signSession(session), { httpOnly: true, sameSite: 'strict', secure: sessionSecure || req.secure, maxAge: sessionLifetime * 1000, path: '/' })
      res.json(result)
    }))
  }
}
