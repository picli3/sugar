import { purgeSchematicReferences } from '../schematics/repository.js'

// Trash: soft-deleted projects, blocks and images, restorable until an explicit purge.
// Purges delete dependent rows explicitly (foreign keys are NO ACTION) inside one transaction.
export const trashRetentionDays = 30
const retained = `deleted_at IS NOT NULL AND deleted_at <= now() - interval '${trashRetentionDays} days'`

const tables = {
  project: { table: 'projects', owner: 'created_by', scope: 'NULL::text' },
  block: { table: 'blocks', owner: 'owner_id', scope: "CASE WHEN owner_id IS NULL THEN 'catalog' ELSE 'personal' END" },
  image: { table: 'images', owner: 'owner_id', scope: "CASE WHEN scope='catalog' THEN 'catalog' ELSE 'personal' END" },
}
export const trashKinds = Object.keys(tables)

export async function initTrashDb(q) {
  // Partial indexes keep trash listings bounded by trashed rows, not by every resource.
  await q('CREATE INDEX IF NOT EXISTS projects_trash ON projects(created_by,deleted_at DESC,id DESC) WHERE deleted_at IS NOT NULL')
  await q('CREATE INDEX IF NOT EXISTS blocks_trash ON blocks(owner_id,deleted_at DESC,id DESC) WHERE deleted_at IS NOT NULL')
  await q('CREATE INDEX IF NOT EXISTS images_trash ON images(owner_id,deleted_at DESC,id DESC) WHERE deleted_at IS NOT NULL')
  await q('CREATE INDEX IF NOT EXISTS image_references_resource ON image_references(resource_kind,resource_id)')
}

export function createTrashRepository(query) {
  return {
    // Returns the row (active or trashed) with ownership facts, optionally locked.
    async find(kind, id, tx = query, lock = false) {
      const { table, owner, scope } = tables[kind]
      return (await tx(`SELECT id,name,${owner} AS owner_id,${scope} AS scope,deleted_at,
        (deleted_at IS NOT NULL AND deleted_at <= now() - interval '${trashRetentionDays} days') AS purgeable,
        to_char((deleted_at + interval '${trashRetentionDays} days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purge_after
        FROM ${table} WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
    },
    async trash(kind, id, tx = query) {
      const { table } = tables[kind]
      const done = (await tx(`UPDATE ${table} SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`, [id])).rowCount
      // A trashed project stops being reachable through private links; restoring does not revive them.
      if (done && kind === 'project') await tx('UPDATE projects SET share_token=NULL,share_expires_at=NULL WHERE id=$1', [id])
      return done
    },
    async restore(kind, id, tx = query) {
      return (await tx(`UPDATE ${tables[kind].table} SET deleted_at=NULL WHERE id=$1 AND deleted_at IS NOT NULL`, [id])).rowCount
    },
    async purge(kind, id, tx) {
      if (kind !== 'image') await purgeSchematicReferences(tx, kind, id)
      if (kind === 'project') {
        await tx("DELETE FROM image_references WHERE resource_kind='project' AND resource_id=$1", [id])
        await tx("DELETE FROM sync_jobs WHERE kind='project' AND record_id=$1", [id])
        // The AI call ledger keeps budget history; it no longer points at the purged project.
        await tx('UPDATE ai_calls SET project_id=NULL WHERE project_id=$1', [id])
        for (const table of ['project_analyses', 'project_members', 'project_revisions', 'project_settings_history']) await tx(`DELETE FROM ${table} WHERE project_id=$1`, [id])
      } else if (kind === 'block') {
        await tx("DELETE FROM image_references WHERE resource_kind='block' AND resource_id=$1", [id])
        await tx('DELETE FROM block_versions WHERE block_id=$1', [id])
      } else {
        await tx('DELETE FROM image_references WHERE image_id=$1', [id])
      }
      return (await tx(`DELETE FROM ${tables[kind].table} WHERE id=$1 AND ${retained}`, [id])).rowCount
    },
    async page(user, { limit, after }) {
      const values = [], bind = value => { values.push(value); return '$' + values.length }
      const admin = user.role === 'Admin'
      const viewer = admin ? null : bind(user.id)
      const boundary = after ? `AND (t.deleted_at,t.id)<(${bind(after.at)}::timestamptz,${bind(after.id)}::uuid)` : ''
      const cap = bind(limit + 1)
      const branch = kind => {
        const { table, owner, scope } = tables[kind]
        return `(SELECT '${kind}'::text AS kind,t.id,t.name,t.${owner} AS owner_id,${scope.replace(/\b(owner_id|scope)\b/g, 't.$1')} AS scope,t.deleted_at
          FROM ${table} t WHERE t.deleted_at IS NOT NULL ${viewer ? `AND t.${owner}=${viewer}::uuid` : ''} ${boundary}
          ORDER BY t.deleted_at DESC,t.id DESC LIMIT ${cap})`
      }
      return (await query(`SELECT r.kind,r.id,r.name,r.scope,r.owner_id,u.email AS owner,
        to_char(r.deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
        r.deleted_at,(r.deleted_at <= now() - interval '${trashRetentionDays} days') AS purgeable,
        to_char((r.deleted_at + interval '${trashRetentionDays} days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purge_after
        FROM (${trashKinds.map(branch).join(' UNION ALL ')}) r LEFT JOIN users u ON u.id=r.owner_id
        ORDER BY r.deleted_at DESC,r.id DESC LIMIT ${cap}`, values)).rows
    },
  }
}
