import crypto from 'node:crypto'
import { githubError } from './protocol.js'

export async function initGithubTargetsDb(q) {
  await q(`CREATE TABLE IF NOT EXISTS github_project_grants(
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,id uuid UNIQUE NOT NULL,
    owner_id uuid NOT NULL,link_id uuid NOT NULL,
    installation_id text NOT NULL CHECK(installation_id ~ '^[1-9][0-9]{0,15}$'),repository_id text NOT NULL CHECK(repository_id ~ '^[1-9][0-9]{0,15}$'),
    repository text NOT NULL CHECK(length(repository) BETWEEN 3 AND 200),branch text NOT NULL CHECK(length(branch) BETWEEN 1 AND 256),
    allow_public boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now())`)
  for (const [name, type] of [['github_grant_id','uuid'],['github_owner_id','uuid'],['github_connection_id','uuid'],['github_installation_id','text'],['github_repository_id','text'],['github_allow_public','boolean']]) await q(`ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS ${name} ${type}`)
  await q(`UPDATE sync_jobs SET status='blocked',error='GITHUB_AUTHORIZATION_REQUIRED'
    WHERE kind='project' AND status='pending' AND github_grant_id IS NULL`)
  await q(`CREATE OR REPLACE FUNCTION sugar_guard_sync_authorization() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.kind='project' AND NEW.status='pending' AND NOT EXISTS(
        SELECT 1 FROM github_project_grants g JOIN projects p ON p.id=g.project_id
        JOIN github_links l ON l.id=g.link_id AND l.user_id=g.owner_id AND l.access_box IS NOT NULL
        JOIN users u ON u.id=g.owner_id AND u.active AND u.role IN ('Admin','dev') AND u.auth_version=l.auth_version
        WHERE g.id=NEW.github_grant_id AND g.project_id=NEW.record_id AND p.deleted_at IS NULL AND p.created_by=g.owner_id
          AND g.owner_id=NEW.github_owner_id AND g.link_id=NEW.github_connection_id AND g.installation_id=NEW.github_installation_id
          AND g.repository_id=NEW.github_repository_id AND g.allow_public IS NOT DISTINCT FROM NEW.github_allow_public
          AND g.repository=NEW.target_repository AND g.branch=NEW.target_branch AND p.sync_repository=g.repository AND p.sync_branch=g.branch
      ) THEN NEW.status:='blocked'; NEW.error:='GITHUB_AUTHORIZATION_REQUIRED'; END IF;
      RETURN NEW;
    END $function$`)
  await q('DROP TRIGGER IF EXISTS sugar_sync_authorization ON sync_jobs')
  await q(`CREATE TRIGGER sugar_sync_authorization BEFORE INSERT OR UPDATE OF status,target_repository,target_branch,github_grant_id,
    github_owner_id,github_connection_id,github_installation_id,github_repository_id,github_allow_public ON sync_jobs
    FOR EACH ROW EXECUTE FUNCTION sugar_guard_sync_authorization()`)
  await q("INSERT INTO settings(key,value) VALUES('github_user_schema_version','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
}
export function createGithubTargets({ q, links, client }) {
  async function state(id, tx = q) {
    return (await tx(`SELECT g.*,(l.id IS NOT NULL AND l.access_box IS NOT NULL AND l.auth_version=u.auth_version AND u.active AND u.role IN ('dev','Admin')) AS authorized
      FROM github_project_grants g LEFT JOIN github_links l ON l.id=g.link_id AND l.user_id=g.owner_id
      LEFT JOIN users u ON u.id=g.owner_id WHERE g.project_id=$1`, [id])).rows[0] || null
  }
  return {
    state,
    async prepare(project, user, sessionId, input, repository, branch) {
      if (project.created_by !== user.id) throw githubError('GITHUB_OWNER_REQUIRED', 403)
      if (!sessionId || typeof input.sync_installation_id !== 'string' || typeof input.sync_repository_id !== 'string' || input.sync_confirm_public !== undefined && typeof input.sync_confirm_public !== 'boolean') throw githubError('GITHUB_INPUT_INVALID', 400)
      return links.withCredential(user.id, { sessionId }, async ({ token, link }) => {
        const allowed = await client.authorize(token, { installationId: input.sync_installation_id, repositoryId: input.sync_repository_id, repository, branch })
        if (!allowed.private && input.sync_confirm_public !== true) throw githubError('GITHUB_REPOSITORY_PUBLIC', 409)
        return { id: crypto.randomUUID(), ownerId: user.id, linkId: link.id, installationId: allowed.installationId,
          repositoryId: allowed.repositoryId, repository: allowed.repository, branch: allowed.branch, allowPublic: input.sync_confirm_public === true }
      })
    },
    async save(tx, id, grant) {
      if (!grant) { await tx('DELETE FROM github_project_grants WHERE project_id=$1', [id]); return }
      await tx(`INSERT INTO github_project_grants(project_id,id,owner_id,link_id,installation_id,repository_id,repository,branch,allow_public)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(project_id) DO UPDATE SET id=excluded.id,owner_id=excluded.owner_id,
        link_id=excluded.link_id,installation_id=excluded.installation_id,repository_id=excluded.repository_id,repository=excluded.repository,
        branch=excluded.branch,allow_public=excluded.allow_public,created_at=clock_timestamp()`, [id,grant.id,grant.ownerId,grant.linkId,grant.installationId,grant.repositoryId,grant.repository,grant.branch,grant.allowPublic])
    },
  }
}
