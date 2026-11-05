// Two bounded credential/state slots per account. Reserve their maximum size
// BEFORE OAuth; settlement and single-use refresh cannot fail at a later quota.
export async function initGithubLinkDb(q) {
  await q(`CREATE OR REPLACE FUNCTION sugar_github_box(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $function$
    SELECT CASE WHEN jsonb_typeof(value)='object' THEN COALESCE(value->'v'='1'::jsonb
      AND value ?& ARRAY['v','iv','tag','data'] AND value-ARRAY['v','iv','tag','data']='{}'::jsonb
      AND jsonb_typeof(value->'iv')='string' AND value->>'iv' ~ '^[a-f0-9]{24}$'
      AND jsonb_typeof(value->'tag')='string' AND value->>'tag' ~ '^[a-f0-9]{32}$'
      AND jsonb_typeof(value->'data')='string' AND length(value->>'data') BETWEEN 2 AND 1024 AND length(value->>'data')%2=0 AND value->>'data' ~ '^[a-f0-9]+$',false) ELSE false END
    $function$`)
  await q(`CREATE TABLE IF NOT EXISTS github_links(
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    id uuid UNIQUE NOT NULL,client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 200 AND client_id ~ '^[A-Za-z0-9_.-]+$'),
    auth_version integer NOT NULL CHECK(auth_version>=0),github_user_id text,github_login text,
    access_box jsonb,refresh_box jsonb,expires_at timestamptz,refresh_expires_at timestamptz,
    refresh_nonce uuid,refresh_started_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT github_refresh_intent CHECK((refresh_nonce IS NULL AND refresh_started_at IS NULL) OR (refresh_nonce IS NOT NULL AND refresh_started_at IS NOT NULL AND access_box IS NOT NULL AND isfinite(refresh_started_at))),
    CONSTRAINT github_link_boxes CHECK((access_box IS NULL OR sugar_github_box(access_box)) AND (refresh_box IS NULL OR sugar_github_box(refresh_box))),
    CONSTRAINT github_link_state CHECK(
      (access_box IS NULL AND github_user_id IS NULL AND github_login IS NULL AND refresh_box IS NULL AND expires_at IS NULL AND refresh_expires_at IS NULL)
      OR (access_box IS NOT NULL AND github_user_id IS NOT NULL AND github_user_id ~ '^[1-9][0-9]{0,15}$'
        AND github_login IS NOT NULL AND github_login ~ '^[A-Za-z0-9-]{1,39}$'
        AND ((refresh_box IS NULL AND expires_at IS NULL AND refresh_expires_at IS NULL)
          OR (refresh_box IS NOT NULL AND expires_at IS NOT NULL AND refresh_expires_at IS NOT NULL AND isfinite(expires_at) AND isfinite(refresh_expires_at)))))
  )`)
  await q(`CREATE TABLE IF NOT EXISTS github_oauth_states(
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,id uuid UNIQUE NOT NULL,
    session_id uuid NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,auth_version integer NOT NULL CHECK(auth_version>=0),
    client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 200 AND client_id ~ '^[A-Za-z0-9_.-]+$'),
    state_hash text UNIQUE NOT NULL CHECK(state_hash ~ '^[a-f0-9]{64}$'),
    verifier_box jsonb NOT NULL CHECK(sugar_github_box(verifier_box) AND length(verifier_box->>'data')=86),
    expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),claimed boolean NOT NULL DEFAULT false
  )`)
  await q(`CREATE OR REPLACE FUNCTION sugar_invalidate_github() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.active IS DISTINCT FROM OLD.active OR NEW.role IS DISTINCT FROM OLD.role OR NEW.auth_version IS DISTINCT FROM OLD.auth_version THEN
        DELETE FROM github_oauth_states WHERE user_id=NEW.id;
        DELETE FROM github_links WHERE user_id=NEW.id;
      END IF;
      RETURN NEW;
    END $function$`)
  await q('DROP TRIGGER IF EXISTS sugar_github_credential_change ON users')
  await q(`CREATE TRIGGER sugar_github_credential_change AFTER UPDATE OF active,role,auth_version ON users FOR EACH ROW EXECUTE FUNCTION sugar_invalidate_github()`)
  await q("INSERT INTO settings(key,value) VALUES('github_user_schema_version','1'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
}
