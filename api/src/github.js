import { reportFailure } from './shared/logging.js'
import { q, transaction } from './db.js'
let defaults
async function defaultIntegration() {
  defaults ||= import('./github-link/integration.js').then(({ createGithubIntegration }) => createGithubIntegration({ q, transaction }))
  return defaults
}
export async function enqueue(kind, id, revision, yaml, query = q, target = null) {
  if (kind !== 'project' || !target?.repository) return
  await query(`INSERT INTO sync_jobs(kind,record_id,revision,yaml,target_repository,target_branch,status,error,
    github_grant_id,github_owner_id,github_connection_id,github_installation_id,github_repository_id,github_allow_public)
    SELECT $1,p.id,$3,$4,$5,$6,CASE WHEN u.id IS NULL THEN 'blocked' ELSE 'pending' END,
      CASE WHEN u.id IS NULL THEN 'GITHUB_AUTHORIZATION_REQUIRED' ELSE NULL END,g.id,g.owner_id,g.link_id,g.installation_id,g.repository_id,g.allow_public
    FROM projects p LEFT JOIN github_project_grants g ON g.project_id=p.id AND g.owner_id=p.created_by AND g.repository=$5 AND g.branch=$6
    LEFT JOIN github_links l ON l.id=g.link_id AND l.user_id=g.owner_id AND l.access_box IS NOT NULL
    LEFT JOIN users u ON u.id=g.owner_id AND u.active AND u.role IN ('dev','Admin') AND u.auth_version=l.auth_version
    WHERE p.id=$2 AND p.deleted_at IS NULL`, [kind,id,revision,yaml,target.repository,target.branch || 'main'])
}
export async function syncOne({ integration } = {}) { return (integration || await defaultIntegration()).worker.tick() }
export function startSync() { setInterval(() => syncOne().catch(error => reportFailure('GitHub worker failed', error)), 10000).unref() }
export function createProjectSyncService({ query, projects, targets, synchronize = syncOne }) {
  return {
    async list(id, user) {
      await projects.get(id, user, { ownerOnly: true })
      return (await query("SELECT revision,status,attempts,error,commit_sha,created_at,target_repository,target_branch FROM sync_jobs WHERE kind='project' AND record_id=$1 ORDER BY id DESC LIMIT 10", [id])).rows
    },
    async target(id, user) {
      const project = await projects.get(id, user, { ownerOnly: true }), own = project.created_by === user.id, target = await targets.state(id)
      return { owner: own, authorized: !!target?.authorized && target.repository === project.sync_repository && target.branch === project.sync_branch,
        target: own && target ? { installationId: target.installation_id, repositoryId: target.repository_id, repository: target.repository, branch: target.branch, allowPublic: target.allow_public } : null }
    },
    async retry(id, user) {
      const project = await projects.get(id, user, { ownerOnly: true })
      if (project.created_by !== user.id) throw Object.assign(new Error('GITHUB_OWNER_REQUIRED'), { status: 403 })
      const grant = await targets.state(id)
      if (!grant?.authorized || grant.repository !== project.sync_repository || grant.branch !== project.sync_branch) throw Object.assign(new Error('GITHUB_AUTHORIZATION_REQUIRED'), { status: 409 })
      await query(`UPDATE sync_jobs SET status='pending',error=NULL,next_attempt_at=now() WHERE kind='project' AND record_id=$1
        AND status IN ('pending','blocked') AND github_grant_id=$2 AND github_connection_id=$3`, [id, grant.id, grant.link_id])
      synchronize().catch(error => reportFailure('GitHub retry failed', error))
    },
  }
}
