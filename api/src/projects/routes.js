import { asyncRoute, noStore } from '../shared/http.js'

export function registerPublicProjectRoutes(app, projects) {
  app.get('/api/public/projects/:id', noStore, asyncRoute(async (req, res) => res.json(await projects.public(req.params.id))))
  app.get('/api/shared/:token', noStore, asyncRoute(async (req, res) => res.json(await projects.shared(req.params.token))))
}

export function registerProjectRoutes(app, projects) {
  app.get('/api/projects/page', noStore, asyncRoute(async (req, res) => res.json(await projects.page(req.user, req.query))))
  app.get('/api/projects', noStore, asyncRoute(async (req, res) => res.json(await projects.list(req.user))))
  app.post('/api/projects', asyncRoute(async (req, res) => res.status(201).json(await projects.create(req.user, req.body))))
  app.patch('/api/projects/:id/settings', asyncRoute(async (req, res) => res.json(await projects.settings(req.params.id, req.user, req.body))))
  app.get('/api/projects/:id/settings/history', noStore, asyncRoute(async (req, res) => res.json(await projects.settingsHistory(req.params.id, req.user))))
  app.get('/api/projects/:id/settings/history/page', noStore, asyncRoute(async (req, res) => res.json(await projects.settingsHistoryPage(req.params.id, req.user, req.query))))
  app.post('/api/projects/:id/share', asyncRoute(async (req, res) => res.json(await projects.share(req.params.id, req.user))))
  app.delete('/api/projects/:id/share', asyncRoute(async (req, res) => { await projects.revokeShare(req.params.id, req.user); res.json({ ok: true }) }))
  app.get('/api/projects/:id/members/page', noStore, asyncRoute(async (req, res) => res.json(await projects.membersPage(req.params.id, req.user, req.query))))
  app.get('/api/projects/:id/members', noStore, asyncRoute(async (req, res) => res.json(await projects.members(req.params.id, req.user))))
  app.get('/api/projects/:id/category-icons', noStore, asyncRoute(async (req, res) => res.json(await projects.icons(req.params.id, req.user, req.query))))
  app.put('/api/projects/:id/members', asyncRoute(async (req, res) => res.json(await projects.setMember(req.params.id, req.user, req.body))))
  app.delete('/api/projects/:id/members/:userId', asyncRoute(async (req, res) => { await projects.removeMember(req.params.id, req.user, req.params.userId); res.json({ ok: true }) }))
  app.get('/api/projects/:id', asyncRoute(async (req, res) => res.json(await projects.get(req.params.id, req.user))))
  app.get('/api/projects/:id/export', asyncRoute(async (req, res) => {
    const project = await projects.get(req.params.id, req.user)
    res.set('Content-Disposition', `attachment; filename="${req.params.id}.yaml"`).type('text/yaml').send(project.yaml)
  }))
  app.put('/api/projects/:id', asyncRoute(async (req, res) => res.json(await projects.save(req.params.id, req.user, req.body))))
  app.get('/api/projects/:id/revisions', noStore, asyncRoute(async (req, res) => res.json(await projects.revisions(req.params.id, req.user))))
  app.get('/api/projects/:id/revisions/page', noStore, asyncRoute(async (req, res) => res.json(await projects.revisionsPage(req.params.id, req.user, req.query))))
  app.get('/api/projects/:id/revisions/:revision', asyncRoute(async (req, res) => res.type('text/yaml').send(await projects.revision(req.params.id, req.user, req.params.revision))))
  app.get('/api/projects/:id/diff', asyncRoute(async (req, res) => res.type('text/plain').send(await projects.diff(req.params.id, req.user, req.query))))
  app.post('/api/projects/:id/restore', asyncRoute(async (req, res) => res.json(await projects.restore(req.params.id, req.user, req.body))))
}
