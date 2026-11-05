import { boundedLegacyList, boundedMetadataPage } from '../shared/legacy-list.js'
// All grants are evaluated against live project/library permissions, never URL secrecy.
const projectRead = `(p.visibility='public' OR p.created_by=$2 OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2))`
const readable = `(
  ($2::uuid IS NOT NULL AND (i.owner_id=$2 OR $3='Admin' OR i.scope='catalog'
    OR EXISTS(SELECT 1 FROM image_references r JOIN blocks b ON b.id=r.resource_id WHERE r.image_id=i.id AND r.resource_kind='block' AND b.deleted_at IS NULL AND (b.owner_id IS NULL OR b.owner_id=$2))
    OR EXISTS(SELECT 1 FROM image_references r JOIN projects p ON p.id=r.resource_id WHERE r.image_id=i.id AND r.resource_kind='project' AND p.deleted_at IS NULL AND ${projectRead})))
  OR EXISTS(SELECT 1 FROM image_references r JOIN projects p ON p.id=r.resource_id WHERE r.image_id=i.id AND r.resource_kind='project' AND r.current AND p.deleted_at IS NULL AND p.visibility='public')
)`
export function createImageRepository(query) {
  return {
    async content(id, user, execute = query) {
      return (await execute(`SELECT i.mime,i.data FROM images i WHERE i.id=$1 AND i.deleted_at IS NULL AND ${readable}`, [id, user?.id || null, user?.role || null])).rows[0]
    },
    async shared(id, token) {
      return (await query(`SELECT i.mime,i.data FROM images i WHERE i.id=$1 AND i.deleted_at IS NULL AND EXISTS(SELECT 1 FROM image_references r JOIN projects p ON p.id=r.resource_id WHERE r.image_id=i.id AND r.resource_kind='project' AND r.current AND p.deleted_at IS NULL AND p.share_token=$2 AND p.share_expires_at>now())`, [id, token])).rows[0]
    },
    async list(user) {
      return boundedLegacyList(query, `SELECT i.id,i.name,i.mime,i.scope,i.owner_id,i.created_at,u.email AS creator FROM images i LEFT JOIN users u ON u.id=i.created_by WHERE i.deleted_at IS NULL AND (i.scope='catalog' OR i.owner_id=$1 OR $2='Admin') ORDER BY i.created_at DESC,i.id DESC`, [user.id, user.role], { order: 'r.created_at DESC,r.id DESC', textFields: ['name','mime','scope','creator'] })
    },
    async page(user, { limit, after }) {
      const values = [], bind = value => { values.push(value); return '$' + values.length }
      const boundary = after ? `AND (i.created_at,i.id)<(${bind(after.at)}::timestamptz,${bind(after.id)}::uuid)` : ''
      const cap = bind(limit + 1)
      const branch = filter => `(SELECT i.id,i.name,i.mime,i.scope,i.owner_id,i.created_at,i.created_by FROM images i
        WHERE i.deleted_at IS NULL ${filter} ${boundary} ORDER BY i.created_at DESC,i.id DESC LIMIT ${cap})`
      // Disjoint partial-index scans cap candidate metadata before joining creator data.
      const candidates = user.role === 'Admin' ? branch('') : branch(`AND i.owner_id=${bind(user.id)}::uuid AND i.scope<>'catalog'`) + ' UNION ALL ' + branch("AND i.scope='catalog'")
      return boundedMetadataPage(query, `SELECT i.id,i.name,i.mime,i.scope,i.owner_id,i.created_at,u.email AS creator,
        to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
        FROM (${candidates}) i LEFT JOIN users u ON u.id=i.created_by
        ORDER BY i.created_at DESC,i.id DESC LIMIT ${cap}`, values, { order: 'r.created_at DESC,r.id DESC', textFields: ['name', 'mime', 'scope', 'creator'], limit })
    },
    async create(id, name, mime, bytes, authorId, ownerId, scope, execute = query) {
      await execute('INSERT INTO images(id,name,mime,data,created_by,owner_id,scope) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, name, mime, bytes, authorId, ownerId, scope])
    },
    async archive(id) { return (await query('UPDATE images SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL', [id])).rowCount },
  }
}
