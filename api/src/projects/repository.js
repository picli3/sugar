import { boundedLegacyList, boundedMetadataPage } from '../shared/legacy-list.js'
const fields = 'p.id,p.name,p.revision,p.yaml,p.visibility,p.created_by,p.sync_repository,p.sync_branch,p.settings_version,p.created_at,u.email AS creator'
const join = 'FROM projects p LEFT JOIN users u ON u.id=p.created_by'

// Every write participating in a transaction receives that transaction's query function.
export function createProjectRepository(query) {
  return {
    async find(id, userId, execute = query, lock = false) {
      // Lock first, then read membership with a fresh statement snapshot after any waiter.
      if (lock) await execute('SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])
      return (await execute(`SELECT ${fields},m.role AS member_role ${join} LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$2 WHERE p.id=$1 AND p.deleted_at IS NULL`, [id, userId])).rows[0]
    },
    async public(id) { return (await query(`SELECT ${fields} ${join} WHERE p.id=$1 AND p.visibility='public' AND p.deleted_at IS NULL`, [id])).rows[0] },
    async shared(token) { return (await query(`SELECT ${fields} ${join} WHERE p.share_token=$1 AND p.share_expires_at>now() AND p.deleted_at IS NULL`, [token])).rows[0] },
    async list(user) {
      return boundedLegacyList(query, `SELECT p.id,p.name,p.revision,p.created_at,p.visibility,p.created_by,p.sync_repository,p.sync_branch,p.settings_version,u.email AS creator ${join} LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$1 WHERE p.deleted_at IS NULL AND (p.visibility='public' OR p.created_by=$1 OR $2='Admin' OR m.user_id IS NOT NULL) ORDER BY p.name,p.id`, [user.id, user.role], { order: 'r.name,r.id', textFields: ['name','visibility','sync_repository','sync_branch','creator'] })
    },
    async access(id, userId) {
      return (await query(`SELECT p.id,p.created_by,p.visibility,m.role AS member_role FROM projects p
        LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$2 WHERE p.id=$1 AND p.deleted_at IS NULL`, [id, userId])).rows[0]
    },
    async page(user, { limit, after }) {
      const values = [], bind = value => { values.push(value); return '$' + values.length }
      const boundary = after ? `AND (p.created_at,p.id)<(${bind(after.at)}::timestamptz,${bind(after.id)}::uuid)` : ''
      const cap = bind(limit + 1)
      const branch = (filter, membership = '') => `(SELECT p.id,p.name,p.revision,p.created_at,p.visibility,p.created_by,p.sync_repository,p.sync_branch,p.settings_version
        FROM projects p ${membership} WHERE p.deleted_at IS NULL ${filter} ${boundary} ORDER BY p.created_at DESC,p.id DESC LIMIT ${cap})`
      let candidates
      if (user.role === 'Admin') candidates = branch('')
      else {
        const owner = bind(user.id) + '::uuid'
        candidates = branch(`AND p.created_by=${owner}`) + ' UNION ALL ' +
          branch(`AND p.visibility='public' AND p.created_by IS DISTINCT FROM ${owner}`) + ' UNION ALL ' +
          branch(`AND p.visibility<>'public' AND p.created_by IS DISTINCT FROM ${owner}`, `JOIN project_members m ON m.project_id=p.id AND m.user_id=${owner}`)
      }
      return boundedMetadataPage(query, `SELECT p.*,u.email AS creator,
        to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
        FROM (${candidates}) p LEFT JOIN users u ON u.id=p.created_by ORDER BY p.created_at DESC,p.id DESC LIMIT ${cap}`, values, { order: 'r.created_at DESC,r.id DESC', textFields: ['name', 'visibility', 'sync_repository', 'sync_branch', 'creator'], limit })
    },
    async members(id) {
      return (await query('SELECT m.user_id,u.email,m.role,u.active FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY u.email', [id])).rows
    },
    async memberAccount(email, tx) {
      return (await tx('SELECT id,email,role,active FROM users WHERE email=$1 AND active=true FOR SHARE', [email])).rows[0]
    },
    async setMember(id, userId, role, tx) {
      await tx('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role', [id, userId, role])
    },
    async removeMember(id, userId, tx) { await tx('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [id, userId]) },
    async create(id, name, yaml, authorId, tx) {
      await tx('INSERT INTO projects(id,name,revision,yaml,created_by) VALUES($1,$2,1,$3,$4)', [id, name, yaml, authorId])
    },
    async addRevision(id, revision, yaml, authorId, summary, tx) {
      await tx('INSERT INTO project_revisions(project_id,revision,yaml,author_id,summary) VALUES($1,$2,$3,$4,$5)', [id, revision, yaml, authorId, summary])
    },
    async save(id, expected, name, yaml, tx) {
      return (await tx('UPDATE projects SET name=$3,yaml=$4,revision=revision+1 WHERE id=$1 AND revision=$2 AND deleted_at IS NULL RETURNING revision', [id, expected, name, yaml])).rows[0]
    },
    async settings(id, expected, visibility, repository, branch, tx) {
      return (await tx('UPDATE projects SET share_expires_at=CASE WHEN visibility IS DISTINCT FROM $3 THEN NULL ELSE share_expires_at END,share_token=CASE WHEN visibility IS DISTINCT FROM $3 THEN NULL ELSE share_token END,visibility=$3,sync_repository=$4,sync_branch=$5,settings_version=settings_version+1 WHERE id=$1 AND settings_version=$2 AND deleted_at IS NULL RETURNING revision,yaml', [id, expected, visibility, repository, branch])).rows[0]
    },
    async addSettingsHistory(id, authorId, before, after, tx) {
      await tx('INSERT INTO project_settings_history(project_id,author_id,before,after) VALUES($1,$2,$3::jsonb,$4::jsonb)', [id, authorId, JSON.stringify(before), JSON.stringify(after)])
    },
    async skipPendingSync(id, tx) {
      await tx("UPDATE sync_jobs SET status='skipped',error='Destino de sincronización cambiado' WHERE kind='project' AND record_id=$1 AND status='pending'", [id])
    },
    async settingsHistory(id) {
      return boundedLegacyList(query, 'SELECT h.id::text AS _legacy_id,h.before,h.after,h.created_at,u.email AS author FROM project_settings_history h LEFT JOIN users u ON u.id=h.author_id WHERE h.project_id=$1 ORDER BY h.id DESC', [id], { order: 'r._legacy_id::bigint DESC', textFields: ['before','after','author'] })
    },
    async settingsHistoryPage(id, { limit, before }) {
      const args = [id], boundary = before === null ? '' : 'AND h.id<$2::bigint'
      if (before !== null) args.push(before)
      args.push(limit + 1)
      return boundedMetadataPage(query, `SELECT h.id::text AS id,h.before,h.after,h.created_at,u.email AS author FROM project_settings_history h
        LEFT JOIN users u ON u.id=h.author_id WHERE h.project_id=$1 ${boundary} ORDER BY h.id DESC LIMIT $${args.length}`, args, { order: 'r.id::bigint DESC', textFields: ['before', 'after', 'author'], limit })
    },
    async share(id, token) {
      return (await query(`UPDATE projects SET share_token=CASE WHEN share_expires_at>now() AND share_token IS NOT NULL THEN share_token ELSE $2 END,share_expires_at=CASE WHEN share_expires_at>now() AND share_token IS NOT NULL THEN share_expires_at ELSE now()+interval '7 days' END WHERE id=$1 AND deleted_at IS NULL RETURNING share_token,share_expires_at`, [id, token])).rows[0]
    },
    async revokeShare(id) { await query('UPDATE projects SET share_token=NULL,share_expires_at=NULL WHERE id=$1', [id]) },
    async archive(id) { await query('UPDATE projects SET deleted_at=now() WHERE id=$1', [id]) },
    async revisions(id) {
      return boundedLegacyList(query, 'SELECT r.revision,r.summary,r.created_at,u.email AS author FROM project_revisions r LEFT JOIN users u ON u.id=r.author_id WHERE project_id=$1 ORDER BY revision DESC', [id], { order: 'r.revision DESC', textFields: ['summary','author'] })
    },
    async revisionsPage(id, { limit, before }) {
      const args = [id], boundary = before === null ? '' : 'AND r.revision<$2::integer'
      if (before !== null) args.push(before)
      args.push(limit + 1)
      return boundedMetadataPage(query, `SELECT r.revision,r.summary,r.created_at,u.email AS author FROM project_revisions r
        LEFT JOIN users u ON u.id=r.author_id WHERE r.project_id=$1 ${boundary} ORDER BY r.revision DESC LIMIT $${args.length}`, args, { order: 'r.revision DESC', textFields: ['summary', 'author'], limit })
    },
    async revision(id, revision) {
      return (await query('SELECT yaml FROM project_revisions WHERE project_id=$1 AND revision=$2', [id, revision])).rows[0]
    },
    async comparison(id, from, to) {
      return (await query('SELECT revision,yaml FROM project_revisions WHERE project_id=$1 AND revision=ANY($2::int[])', [id, [from, to]])).rows
    },
  }
}
