import { asyncRoute } from '../shared/http.js'

export function registerSyncRoutes(app, sync) {
  app.get('/api/projects/:id/github-target', asyncRoute(async (req, res) => res.json(await sync.target(req.params.id, req.user))))
  app.get('/api/projects/:id/sync', asyncRoute(async (req, res) => res.json(await sync.list(req.params.id, req.user))))
  app.post('/api/projects/:id/sync/retry', asyncRoute(async (req, res) => { await sync.retry(req.params.id, req.user); res.json({ ok: true }) }))
}
