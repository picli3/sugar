import { asyncRoute, noStore } from '../shared/http.js'

export function registerMfaRoutes(app, { mfa, gate }) {
  app.get('/api/me/mfa', noStore, asyncRoute(async (req, res) => res.json(await mfa.status(req.user))))
  for (const [path, method] of [['enroll','begin'],['confirm','confirm'],['recovery-codes','regenerate'],['disable','disable']]) {
    app.post('/api/me/mfa/' + path, noStore, gate, asyncRoute(async (req, res) => res.json(await mfa[method](req.user, req.sessionId, req.body))))
  }
}
