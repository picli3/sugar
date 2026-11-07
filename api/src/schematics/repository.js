// Only the current project revision can grant anonymous or share-link access.
const readable = `(
  EXISTS(SELECT 1 FROM schematic_references r JOIN projects p ON p.id=r.resource_id
    WHERE r.schematic_id=s.id AND r.resource_kind='project' AND p.deleted_at IS NULL
      AND ((r.current AND p.visibility='public') OR ($2::uuid IS NOT NULL AND (
        p.visibility='public' OR p.created_by=$2 OR $3='Admin' OR EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2)))))
  OR ($2::uuid IS NOT NULL AND EXISTS(
    SELECT 1 FROM schematic_references r JOIN blocks b ON b.id=r.resource_id
    WHERE r.schematic_id=s.id AND r.resource_kind='block' AND b.deleted_at IS NULL
      AND (b.owner_id IS NULL OR b.owner_id=$2 OR $3='Admin')))
)`

export async function initSchematicsDb(q) {
  await q(`CREATE TABLE IF NOT EXISTS schematics(
    id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),
    data bytea NOT NULL CHECK(octet_length(data) BETWEEN 1 AND 1000000)
  )`)
  await q(`CREATE TABLE IF NOT EXISTS schematic_references(
    schematic_id uuid NOT NULL REFERENCES schematics(id),
    resource_kind text NOT NULL CHECK(resource_kind IN ('block','project')),
    resource_id uuid NOT NULL, current boolean NOT NULL,
    PRIMARY KEY(schematic_id,resource_kind,resource_id)
  )`)
  await q('CREATE INDEX IF NOT EXISTS schematic_references_resource ON schematic_references(resource_kind,resource_id)')
}

// The resource is already locked. Lock files in the same order as attachment
// writes so the last reference and its file are collected atomically.
export async function purgeSchematicReferences(tx, kind, resourceId) {
  const ids = (await tx(`SELECT s.id FROM schematics s JOIN schematic_references r ON r.schematic_id=s.id
    WHERE r.resource_kind=$1 AND r.resource_id=$2 ORDER BY s.id FOR UPDATE OF s`, [kind, resourceId])).rows.map(row => row.id)
  if (!ids.length) return
  await tx('DELETE FROM schematic_references WHERE resource_kind=$1 AND resource_id=$2', [kind, resourceId])
  await tx(`DELETE FROM schematics s WHERE s.id=ANY($1::uuid[])
    AND NOT EXISTS(SELECT 1 FROM schematic_references r WHERE r.schematic_id=s.id)`, [ids])
}

export function createSchematicRepository(query) {
  return {
    async create(tx, id, { name, data }) {
      await tx('INSERT INTO schematics(id,name,data) VALUES($1,$2,$3)', [id, name, data])
    },
    async content(id, user) {
      return (await query(`SELECT s.name,s.data FROM schematics s WHERE s.id=$1 AND ${readable}`,
        [id, user?.id || null, user?.role || null])).rows[0]
    },
    async shared(id, token) {
      return (await query(`SELECT s.name,s.data FROM schematics s WHERE s.id=$1 AND EXISTS(
        SELECT 1 FROM schematic_references r JOIN projects p ON p.id=r.resource_id
        WHERE r.schematic_id=s.id AND r.resource_kind='project' AND r.current AND p.deleted_at IS NULL
          AND p.share_token=$2 AND p.share_expires_at>now())`, [id, token])).rows[0]
    },
    async attach(tx, kind, resourceId, ids, user, createdId) {
      if (ids.length) {
        await tx('SELECT id FROM schematics WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
        const allowed = await tx(`SELECT s.id FROM schematics s WHERE s.id=ANY($1::uuid[]) AND (s.id=$4 OR ${readable})`,
          [ids, user.id, user.role, createdId || null])
        if (allowed.rowCount !== ids.length) return false
      }
      await tx('UPDATE schematic_references SET current=false WHERE resource_kind=$1 AND resource_id=$2 AND current', [kind, resourceId])
      if (ids.length) await tx(`INSERT INTO schematic_references(schematic_id,resource_kind,resource_id,current)
        SELECT unnest($1::uuid[]),$2,$3,true ON CONFLICT(schematic_id,resource_kind,resource_id) DO UPDATE SET current=true`,
      [ids, kind, resourceId])
      return true
    },
  }
}
