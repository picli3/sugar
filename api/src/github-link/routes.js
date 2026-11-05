import { asyncRoute, noStore } from '../shared/http.js'
export function registerGithubLinkRoutes(app, { links, credentialGate, providerGate }) {
  app.get('/api/me/github', noStore, asyncRoute(async (req, res) => res.json(await links.status(req.user))))
  for (const [path, method] of [['authorize','begin'],['complete','complete'],['disconnect','disconnect']]) {
    app.post('/api/me/github/' + path, noStore, credentialGate, providerGate, asyncRoute(async (req, res) => res.json(await links[method](req.user,req.sessionId,req.body))))
  }
  app.get('/api/me/github/installations', noStore, providerGate, asyncRoute(async (req, res) => res.json(await links.installations(req.user,req.sessionId))))
  app.get('/api/me/github/installations/:id/repositories', noStore, providerGate, asyncRoute(async (req, res) => res.json(await links.repositories(req.user,req.sessionId,req.params.id))))
}
