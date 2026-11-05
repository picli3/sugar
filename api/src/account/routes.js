import { once } from 'node:events'
import { asyncRoute, noStore } from '../shared/http.js'
import { reportFailure } from '../shared/logging.js'

// Streams the archive with backpressure. Errors before the first byte use the normal JSON
// error path; afterwards the response is aborted so a truncated archive cannot look complete.
export function registerAccountExportRoutes(app, accountExport) {
  app.get('/api/me/export', noStore, asyncRoute(async (req, res) => {
    const release = accountExport.begin(req.user)
    let started = false
    try {
      const write = async chunk => {
        if (res.destroyed) throw Object.assign(new Error('Client closed export'), { code: 'EXPORT_ABORTED' })
        if (!started) {
          started = true
          res.status(200).set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="sugar-export-${new Date().toISOString().slice(0, 10)}.zip"`, 'X-Content-Type-Options': 'nosniff' })
        }
        if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')])
      }
      await accountExport.write(req.user, write)
      res.end()
    } catch (error) {
      if (!started) throw error
      if (error.code !== 'EXPORT_ABORTED') reportFailure('Account export failed', error)
      res.destroy()
    } finally { release() }
  }))
}
