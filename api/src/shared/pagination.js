import { error } from './http.js'
const invalid = () => error(400, 'Paginación inválida / Invalid pagination')
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function pageLimit(query) {
  if (Object.keys(query).some(key => !['limit','cursor'].includes(key))) invalid()
  const limit = query.limit === undefined ? 30 : typeof query.limit === 'string' && /^[1-9]\d{0,2}$/.test(query.limit) ? Number(query.limit) : 0
  if (limit < 1 || limit > 100) invalid()
  return limit
}
export function pageInput(query = {}) {
  const limit = pageLimit(query)
  let after = null
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) invalid()
    try {
      const bytes = Buffer.from(query.cursor, 'base64url')
      if (bytes.toString('base64url') !== query.cursor) invalid()
      after = JSON.parse(bytes.toString())
      if (!after || Array.isArray(after) || Object.keys(after).sort().join(',') !== 'at,id' || typeof after.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.at) || Number(after.at.slice(0,4)) < 1 || new Date(after.at).toISOString().slice(0,23) !== after.at.slice(0,23) || typeof after.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(after.id)) invalid()
    } catch { invalid() }
  }
  return { limit, after }
}
export function revisionPageInput(query = {}) {
  const limit = pageLimit(query)
  const cursor = query.cursor
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[1-9]\d{0,9}$/.test(cursor) || Number(cursor) > 2147483647)) invalid()
  return { limit, before: cursor === undefined ? null : Number(cursor) }
}
export function identifierPageInput(query = {}) {
  const limit = pageLimit(query)
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || !uuid.test(query.cursor))) invalid()
  return { limit, after: query.cursor ?? null }
}
export function bigintPageInput(query = {}) {
  const limit = pageLimit(query), cursor = query.cursor
  if (cursor !== undefined && (typeof cursor !== 'string' || !/^[1-9]\d{0,18}$/.test(cursor) || BigInt(cursor) > 9223372036854775807n)) invalid()
  return { limit, before: cursor ?? null }
}
export function identifierPageResult(rows, limit, serialize, more = rows.length > limit) {
  const items = rows.slice(0, limit)
  return { items: items.map(serialize), nextCursor: more && items.length ? items.at(-1).id : null }
}
export function revisionPageResult(rows, limit, field, more = rows.length > limit) {
  const items = rows.slice(0, limit)
  return { items, nextCursor: more && items.length ? String(items.at(-1)[field]) : null }
}
export function pageResult(rows, limit, serialize, more = rows.length > limit) {
  const visible = rows.slice(0, limit), last = visible.at(-1)
  return {
    items: visible.map(({ cursor_time, ...row }) => serialize(row)),
    nextCursor: more && last ? Buffer.from(JSON.stringify({ at: last.cursor_time, id: last.id })).toString('base64url') : null,
  }
}
