export const syncJobMetadataBytes = 1024
export function createDocumentStorageRepository(q) {
  const lock = tx => tx("SELECT pg_advisory_xact_lock(hashtext('sugar:document-storage'))")
  const config = async (tx = q) => {
    const row = (await tx('SELECT value,version FROM document_storage_config WHERE id=true')).rows[0]
    return row
  }
  async function usage(ownerId = null, tx = q) {
    const projectFilter = ownerId ? 'WHERE p.created_by=$1' : '', blockFilter = ownerId ? 'WHERE b.owner_id=$1' : ''
    const syncBytes = `octet_length(s.yaml)::bigint+COALESCE(octet_length(s.target_repository),0)+COALESCE(octet_length(s.target_branch),0)+${syncJobMetadataBytes}`
    const syncRows = ownerId ? `SELECT 'sync',${syncBytes} FROM sync_jobs s JOIN projects p ON p.id=s.record_id WHERE s.kind='project' AND p.created_by=$1
      UNION ALL SELECT 'sync',${syncBytes} FROM sync_jobs s JOIN blocks b ON b.id=s.record_id WHERE s.kind='block' AND b.owner_id=$1` : `SELECT 'sync',${syncBytes} FROM sync_jobs s`
    return (await tx(`SELECT count(*) FILTER(WHERE kind='project') AS projects,count(*) FILTER(WHERE kind='block') AS blocks,
      count(*) FILTER(WHERE kind='revision') AS revisions,count(*) FILTER(WHERE kind='sync') AS sync_jobs,COALESCE(sum(bytes),0) AS bytes FROM (
      SELECT 'project' AS kind,octet_length(p.yaml)::bigint+octet_length(p.name) AS bytes FROM projects p ${projectFilter}
      UNION ALL SELECT 'block',octet_length(b.name) FROM blocks b ${blockFilter}
      UNION ALL SELECT 'revision',octet_length(r.yaml)::bigint+octet_length(r.summary) FROM project_revisions r JOIN projects p ON p.id=r.project_id ${projectFilter}
      UNION ALL SELECT 'revision',octet_length(v.yaml)::bigint+octet_length(v.summary) FROM block_versions v JOIN blocks b ON b.id=v.block_id ${blockFilter}
      UNION ALL ${syncRows}
      ) retained`, ownerId ? [ownerId] : [])).rows[0]
  }
  return {
    lock, config, usage,
    async target(kind, id, tx) {
      const project = kind === 'project'
      const target = (await tx(project ? 'SELECT created_by AS owner_id FROM projects WHERE id=$1' : 'SELECT owner_id FROM blocks WHERE id=$1', [id])).rows[0]
      if (!target) return null
      const revisions = (await tx(project ? 'SELECT count(*) AS total FROM project_revisions WHERE project_id=$1' : 'SELECT count(*) AS total FROM block_versions WHERE block_id=$1', [id])).rows[0].total
      return { ownerId: target.owner_id, revisions }
    },
    async configure(limits, expected, tx) {
      return (await tx('UPDATE document_storage_config SET value=$1::jsonb,version=version+1 WHERE id=true AND version=$2 RETURNING version', [JSON.stringify(limits), expected])).rowCount
    },
  }
}
