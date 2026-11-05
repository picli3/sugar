import { asyncRoute, noStore } from '../shared/http.js'
import { requireAdmin } from '../auth/policies.js'

export function registerTotalStorageRoutes(app, storage) {
  app.get('/api/total-storage', noStore, asyncRoute(async (req, res) => { requireAdmin(req.user); res.json(await storage.configuration()) }))
  app.put('/api/total-storage', noStore, asyncRoute(async (req, res) => { requireAdmin(req.user); res.json(await storage.configure(req.body)) }))
}
