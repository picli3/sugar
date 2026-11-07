import { asyncRoute, noStore } from '../shared/http.js'

function download(res, file) {
  res.attachment(file.name).type('application/octet-stream')
    .set('Cross-Origin-Resource-Policy', 'same-origin').end(file.data)
}

export function registerSchematicRoutes(app, schematics, auth) {
  app.get('/api/schematics/:id/content', noStore, asyncRoute(async (req, res) => {
    let user = null
    if (req.cookies.session) {
      try { user = await auth.authenticate(req.cookies.session) }
      catch (e) {
        if (e.status !== 401 && !['JsonWebTokenError','TokenExpiredError'].includes(e.name)) throw e
      }
    }
    download(res, await schematics.content(req.params.id, user))
  }))
  app.get('/api/shared/:token/schematics/:id/content', noStore, asyncRoute(async (req, res) => {
    download(res, await schematics.shared(req.params.id, req.params.token))
  }))
}
