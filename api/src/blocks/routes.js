import { asyncRoute, noStore } from '../shared/http.js'

export function registerBlockRoutes(app, blocks) {
  app.get('/api/blocks/page', noStore, asyncRoute(async (req, res) => res.json(await blocks.page(req.user, req.query))))
  app.get('/api/blocks', noStore, asyncRoute(async (req, res) => res.json(await blocks.list(req.user))))
  app.post('/api/blocks', asyncRoute(async (req, res) => res.status(201).json(await blocks.create(req.user, req.body))))
  app.post('/api/blocks/latest-versions', noStore, asyncRoute(async (req, res) => res.json(await blocks.latestVersions(req.user, req.body))))
  app.get('/api/blocks/:id', noStore, asyncRoute(async (req, res) => res.json(await blocks.get(req.params.id, req.user))))
  app.get('/api/blocks/:id/versions', noStore, asyncRoute(async (req, res) => res.json(await blocks.versions(req.params.id, req.user))))
  app.get('/api/blocks/:id/versions/page', noStore, asyncRoute(async (req, res) => res.json(await blocks.versionsPage(req.params.id, req.user, req.query))))
  app.get('/api/blocks/:id/versions/:version', asyncRoute(async (req, res) => res.type('text/yaml').send(await blocks.version(req.params.id, req.params.version, req.user))))
  app.get('/api/blocks/:id/diff', asyncRoute(async (req, res) => res.type('text/plain').send(await blocks.diff(req.params.id, req.query, req.user))))
  app.post('/api/blocks/:id/restore', asyncRoute(async (req, res) => res.json(await blocks.restore(req.params.id, req.user, req.body))))
  app.put('/api/blocks/:id', asyncRoute(async (req, res) => res.json(await blocks.save(req.params.id, req.user, req.body))))
}
