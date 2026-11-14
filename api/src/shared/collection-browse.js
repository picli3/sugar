import crypto from 'node:crypto'
import { error } from './http.js'
import { boundedMetadataPage } from './legacy-list.js'
import { person, personColumns, personTextFields } from './identity.js'

const fields = { created: 'created_at', modified: 'updated_at', name: 'name', size: 'size_bytes' }
const invalid = () => error(400, 'Filtros inválidos / Invalid filters')
const datePattern = /^\d{4}-\d{2}-\d{2}$/

export function collectionInput(query = {}) {
  const allowed = ['limit', 'cursor', 'sort', 'direction', 'name', 'createdFrom', 'createdTo', 'modifiedFrom', 'modifiedTo', 'minBytes', 'maxBytes']
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) invalid()
  const sort = query.sort ?? 'default', direction = query.direction ?? 'desc'
  if (!['default', ...Object.keys(fields)].includes(sort) || !['asc', 'desc'].includes(direction)) invalid()
  const limit = query.limit === undefined ? 30 : /^[1-9]\d{0,2}$/.test(query.limit) ? Number(query.limit) : 0
  if (limit < 1 || limit > 100 || (query.name || '').length > 200) invalid()
  for (const key of ['createdFrom', 'createdTo', 'modifiedFrom', 'modifiedTo']) {
    if (query[key] && (!datePattern.test(query[key]) || query[key].startsWith('0000') ||
      !Number.isFinite(Date.parse(query[key])) || new Date(query[key]).toISOString().slice(0, 10) !== query[key])) invalid()
  }
  for (const key of ['minBytes', 'maxBytes']) {
    if (query[key] && (!/^\d{1,10}$/.test(query[key]) || Number(query[key]) > 2147483647)) invalid()
  }
  if ((query.createdFrom && query.createdTo && query.createdFrom > query.createdTo) ||
    (query.modifiedFrom && query.modifiedTo && query.modifiedFrom > query.modifiedTo) ||
    (query.minBytes && query.maxBytes && Number(query.minBytes) > Number(query.maxBytes))) invalid()
  const filters = Object.fromEntries(allowed.filter(key => !['limit', 'cursor'].includes(key)).map(key => [key, query[key] || '']))
  const context = crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex')
  let after = null
  if (query.cursor !== undefined) {
    if (query.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) invalid()
    try {
      const bytes = Buffer.from(query.cursor, 'base64url')
      if (bytes.toString('base64url') !== query.cursor) invalid()
      after = JSON.parse(bytes.toString())
      if (Object.keys(after).sort().join(',') !== 'context,favorite,id,key' || after.context !== context ||
        typeof after.favorite !== 'boolean' || typeof after.key !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(after.id)) invalid()
      if (sort === 'size' && !after.favorite) {
        if (!/^\d{1,10}$/.test(after.key) || Number(after.key) > 2147483647) invalid()
      } else if (sort !== 'name' || after.favorite) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.key) ||
          !Number.isFinite(Date.parse(after.key)) || after.key.startsWith('0000') ||
          new Date(after.key).toISOString().slice(0, 23) !== after.key.slice(0, 23)) invalid()
      }
    } catch { invalid() }
  }
  return { ...query, sort, direction, limit, context, after }
}

export async function browseCollection(q, kind, user, query) {
  const input = collectionInput(query), project = kind === 'project'
  const args = [], bind = value => { args.push(value); return '$' + args.length }
  const owner = project || user.role !== 'Admin' ? bind(user.id) + '::uuid' : 'NULL::uuid'
  const favorite = project ? `EXISTS(SELECT 1 FROM project_favorites f WHERE f.user_id=${owner} AND f.project_id=p.id)` : 'false'
  const accessible = user.role === 'Admin' ? 'true' : project
    ? `(p.created_by=${owner} OR p.visibility='public' OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=${owner}))`
    : `(p.owner_id=${owner} OR p.scope='catalog')`
  const conditions = ['p.deleted_at IS NULL', accessible]
  if (input.name) conditions.push(`strpos(lower(p.name),lower(${bind(input.name)}::text))>0`)
  for (const [prefix, column] of [['created', 'created_at'], ['modified', 'updated_at']]) {
    if (input[prefix + 'From']) conditions.push(`p.${column}>=${bind(input[prefix + 'From'] + 'T00:00:00Z')}::timestamptz`)
    if (input[prefix + 'To']) conditions.push(`p.${column}<${bind(input[prefix + 'To'] + 'T00:00:00Z')}::timestamptz+interval '1 day'`)
  }
  if (input.minBytes) conditions.push(`p.size_bytes>=${bind(input.minBytes)}::int`)
  if (input.maxBytes) conditions.push(`p.size_bytes<=${bind(input.maxBytes)}::int`)
  const field = fields[input.sort] || 'created_at', direction = input.sort === 'default' ? 'DESC' : input.direction.toUpperCase()
  const cast = field === 'size_bytes' ? 'integer' : field === 'name' ? 'text' : 'timestamptz'
  let boundary = ''
  if (input.after) {
    if (!project && input.after.favorite) invalid()
    const key = bind(input.after.key), id = bind(input.after.id)
    boundary = project && input.after.favorite
      ? `WHERE NOT p.favorite OR (p.created_at,p.id)>(${key}::timestamptz,${id}::uuid)`
      : `WHERE NOT p.favorite AND (p.${field},p.id)${direction === 'ASC' ? '>' : '<'}(${key}::${cast},${id}::uuid)`
  }
  const order = alias => `${alias}.favorite DESC,
    CASE WHEN ${alias}.favorite THEN ${alias}.created_at END, CASE WHEN ${alias}.favorite THEN ${alias}.id END,
    ${alias}.${field} ${direction},${alias}.id ${direction}`
  const columns = project ? 'p.revision,p.visibility,p.sync_repository,p.sync_branch,p.settings_version' : 'p.mime,p.scope,p.owner_id'
  const time = column => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  const sortKey = cast === 'timestamptz' ? time('p.' + field) : `p.${field}::text`
  const page = await boundedMetadataPage(q, `WITH visible AS (
    SELECT p.id,p.name,p.created_at,p.updated_at,p.size_bytes,p.created_by,${columns},${favorite} AS favorite
    FROM ${project ? 'projects' : 'images'} p WHERE ${conditions.join(' AND ')}
  ) SELECT p.*,${personColumns('u', 'p.created_by', 'creator')},
    CASE WHEN p.favorite THEN ${time('p.created_at')} ELSE ${sortKey} END AS cursor_key
    FROM visible p LEFT JOIN users u ON u.id=p.created_by ${boundary} ORDER BY ${order('p')} LIMIT ${bind(input.limit + 1)}`,
  args, { order: order('r'), textFields: ['name', 'cursor_key', ...personTextFields('creator')], limit: input.limit })
  const last = page.rows.at(-1)
  const nextCursor = page.more && last ? Buffer.from(JSON.stringify({
    id: last.id, key: last.cursor_key, favorite: last.favorite, context: input.context,
  })).toString('base64url') : null
  if (nextCursor?.length > 4096) error(413, 'Nombre antiguo demasiado largo para ordenar / Legacy name too long to sort')
  return { items: page.rows.map(({ cursor_key, ...row }) => {
    const item = person(row, user, 'creator')
    if (!project) { delete item.favorite; item.url = `/api/images/${item.id}/content` }
    return item
  }), nextCursor }
}
