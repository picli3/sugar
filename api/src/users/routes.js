import { asyncRoute, noStore } from '../shared/http.js'

export function registerUserRoutes(app, users) {
  app.get('/api/me', noStore, (req, res) => res.json(req.user))
  app.patch('/api/me', asyncRoute(async (req, res) => res.json(await users.preferences(req.user, req.body))))
  app.post('/api/me/password', noStore, asyncRoute(async (req, res) => { await users.password(req.user, req.body); res.clearCookie('session', { path: '/' }); res.json({ ok: true }) }))
  app.get('/api/users/page', noStore, asyncRoute(async (req, res) => res.json(await users.page(req.user, req.query))))
  app.get('/api/users', noStore, asyncRoute(async (req, res) => res.json(await users.list(req.user))))
  app.post('/api/users', asyncRoute(async (req, res) => res.status(201).json(await users.create(req.user, req.body))))
  app.patch('/api/users/:id', asyncRoute(async (req, res) => res.json(await users.role(req.user, req.params.id, req.body))))
  app.delete('/api/users/:id', asyncRoute(async (req, res) => { await users.archive(req.user, req.params.id); res.json({ ok: true }) }))
}
