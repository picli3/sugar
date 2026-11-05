import { failureCode, reportFailure } from '../shared/logging.js'
const transient = new Set(['GITHUB_TIMEOUT','GITHUB_UNAVAILABLE','GITHUB_RATE_LIMITED','GITHUB_RESPONSE_INVALID','GITHUB_RESPONSE_TOO_LARGE','GITHUB_REFRESH_IN_PROGRESS','UNEXPECTED_ERROR','ECONNREFUSED','ETIMEDOUT'])
export function createGithubSynchronizer({ q, links, client, config }) {
  let running = false
  const outcome = async (query, job, error) => {
    const code = failureCode(error), retry = transient.has(code)
    await query(`UPDATE sync_jobs SET status=$3,attempts=attempts+1,error=$2,
      next_attempt_at=now()+((LEAST(POWER(2,LEAST(attempts,12)),3600))::text||' seconds')::interval
      WHERE id=$1 AND status='pending'`, [job.id, code, retry ? 'pending' : 'blocked'])
  }
  return {
    async tick() {
      if (running || !config.available) return
      running = true
      let job, recorded = false
      try {
        job = (await q("SELECT * FROM sync_jobs WHERE kind='project' AND status='pending' AND next_attempt_at<=now() AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=sync_jobs.record_id AND p.deleted_at IS NOT NULL) ORDER BY id LIMIT 1")).rows[0]
        if (!job) return
        if (!job.github_owner_id || !job.github_connection_id) { await outcome(q, job, { code: 'GITHUB_AUTHORIZATION_REQUIRED' }); return }
        await links.withCredential(job.github_owner_id, { linkId: job.github_connection_id }, async ({ tx, user, link, token }) => {
          // Account/link are leased first. Project precedes job locking, matching
          // project/settings/trash writers; two replicas cannot publish one job.
          const project = (await tx('SELECT id,created_by,sync_repository,sync_branch,deleted_at FROM projects WHERE id=$1 FOR SHARE', [job.record_id])).rows[0]
          const current = (await tx('SELECT * FROM sync_jobs WHERE id=$1 FOR UPDATE SKIP LOCKED', [job.id])).rows[0]
          if (!current || current.status !== 'pending') return
          const grant = (await tx('SELECT * FROM github_project_grants WHERE project_id=$1', [job.record_id])).rows[0]
          const valid = project && !project.deleted_at && grant && project.created_by === user.id && grant.owner_id === user.id &&
            grant.id === current.github_grant_id && grant.link_id === link.id && current.github_connection_id === link.id &&
            grant.installation_id === current.github_installation_id && grant.repository_id === current.github_repository_id &&
            grant.allow_public === current.github_allow_public && grant.repository === current.target_repository && grant.branch === current.target_branch &&
            project.sync_repository === grant.repository && project.sync_branch === grant.branch
          if (!valid) { await outcome(tx, current, { code: 'GITHUB_AUTHORIZATION_REQUIRED' }); recorded = true; return }
          try {
            const result = await client.writeRevision(token, { installationId: grant.installation_id, repositoryId: grant.repository_id,
              repository: grant.repository, branch: grant.branch, allowPublic: grant.allow_public }, { id: current.record_id, revision: current.revision, yaml: current.yaml })
            await tx("UPDATE sync_jobs SET status='synced',error=NULL,commit_sha=$2 WHERE id=$1", [current.id, result.commitSha])
            recorded = true
          } catch (error) { await outcome(tx, current, error); recorded = true; throw error }
        })
      } catch (error) {
        if (job && !recorded) await outcome(q, job, error)
        reportFailure('GitHub sync failed', error)
      } finally { running = false }
    },
  }
}
