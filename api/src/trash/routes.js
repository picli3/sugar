import { asyncRoute, noStore } from '../shared/http.js'

// The resource DELETE routes send to the trash; /api/trash restores or purges.
export function registerTrashRoutes(app, trash) {
  for (const [kind, base] of [['project', 'projects'], ['block', 'blocks'], ['image', 'images']]) {
    app.delete(`/api/${base}/:id`, asyncRoute(async (req, res) => { await trash.trash(kind, req.params.id, req.user); res.json({ ok: true, trashed: true, retentionDays: trash.retentionDays }) }))
  }
  app.get('/api/trash', noStore, asyncRoute(async (req, res) => res.json(await trash.page(req.user, req.query))))
  app.post('/api/trash/:kind/:id/restore', noStore, asyncRoute(async (req, res) => res.json(await trash.restore(req.params.kind, req.params.id, req.user))))
  app.delete('/api/trash/:kind/:id', noStore, asyncRoute(async (req, res) => res.json(await trash.purge(req.params.kind, req.params.id, req.user, req.body))))
}
