import { asyncRoute, noStore } from '../shared/http.js'

function sendImage(res, image) {
  // res.end avoids Express generating an ETag / conditional 304 for protected bytes.
  res.set('X-Content-Type-Options', 'nosniff').set('Cross-Origin-Resource-Policy', 'same-origin').type(image.mime).end(image.data)
}
export function registerImageContentRoute(app, images, auth) {
  app.get('/api/images/:id/content', noStore, asyncRoute(async (req, res) => {
    let user = null
    if (req.cookies.session) { try { user = await auth.authenticate(req.cookies.session) } catch (e) { if (e.status !== 401 && !['JsonWebTokenError','TokenExpiredError'].includes(e.name)) throw e } }
    sendImage(res, await images.content(req.params.id, user))
  }))
  app.get('/api/shared/:token/images/:id/content', noStore, asyncRoute(async (req, res) => sendImage(res, await images.shared(req.params.id, req.params.token))))
}
export function registerImageRoutes(app, images) {
  app.get('/api/images/page', noStore, asyncRoute(async (req, res) => res.json(await images.page(req.user, req.query))))
  app.get('/api/images', noStore, asyncRoute(async (req, res) => res.json(await images.list(req.user))))
  app.post('/api/images', asyncRoute(async (req, res) => res.status(201).json(await images.create(req.user, req.body))))
}
