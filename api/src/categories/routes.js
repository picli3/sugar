import { asyncRoute, noStore } from '../shared/http.js'
import { requireEdit } from '../auth/policies.js'
import { archiveCategory, createCategory, listCategories, renameCategory } from '../categories.js'
import { createCategoryRepository } from './repository.js'
import { createCategoryReadService } from './service.js'

// Category validation and transactional operations already live in categories.js.
export function registerCategoryRoutes(app, { query, transaction }) {
  const categories = createCategoryReadService(createCategoryRepository(query))
  app.get('/api/categories/page', noStore, asyncRoute(async (req, res) => res.json(await categories.page(req.user, req.query))))
  app.post('/api/categories/resolve', noStore, asyncRoute(async (req, res) => res.json(await categories.resolve(req.user, req.body))))
  app.get('/api/categories', noStore, asyncRoute(async (req, res) => res.json(await listCategories(query, req.user))))
  app.post('/api/categories', asyncRoute(async (req, res) => {
    requireEdit(req.user)
    res.status(201).json(await transaction(tx => createCategory(req.body.name, req.body.parentId || null, tx, req.body.icon, req.user, req.body.scope)))
  }))
  app.patch('/api/categories/:id', asyncRoute(async (req, res) => {
    requireEdit(req.user)
    res.json(await transaction(tx => renameCategory(req.params.id, req.body.name, tx, req.body.icon, req.user)))
  }))
  app.delete('/api/categories/:id', asyncRoute(async (req, res) => {
    requireEdit(req.user)
    await transaction(tx => archiveCategory(req.params.id, tx, req.user))
    res.json({ ok: true })
  }))
}
