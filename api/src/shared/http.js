import { GithubFailure, githubFailureCodes } from '../github-link/protocol.js'
import { reportFailure } from './logging.js'
export const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
export const error = (status, message) => { throw Object.assign(new Error(message), { status }) }
export const requiredText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) error(400, `${label} obligatorio`)
  return value.trim()
}

export function errorHandler(err, req, res, _next) {
  if (err.status === 429) res.set('Retry-After', String(err.retryAfter || 1)).set('Cache-Control', 'private, no-store')
  if (err instanceof GithubFailure && githubFailureCodes.has(err.code)) return res.status(err.status).json({ code: err.code, error: err.code })
  if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con ese nombre o identificador' })
  if (err.code === '22P02') return res.status(400).json({ error: 'Identificador inválido' })
  if (err.code === 'PZ001') return res.status(409).json({ code: 'storageQuotaExceeded', error: 'Cuota de almacenamiento agotada; contacta al administrador / Storage quota exhausted; contact the administrator' })
  if (err.code === 'PZ002') return res.status(503).json({ code: 'storageUnavailable', error: 'Migra la configuración de almacenamiento / Migrate storage configuration' })
  const status = err.status || (err.name === 'JsonWebTokenError' ? 401 : 500)
  if (status === 500) reportFailure('HTTP request failed', err, req?.requestId)
  res.status(status).json({ error: status === 500 ? 'Error interno' : err.message })
}

export const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store').set('Pragma', 'no-cache').set('Referrer-Policy', 'no-referrer').vary('Cookie')
  next()
}
