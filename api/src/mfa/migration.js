// One bounded record per account. No raw seed, challenge or recovery code is stored.
// This stage provisions storage only; authentication does not invoke MFA yet.
export async function initMfaDb(q) {
  await q(`CREATE OR REPLACE FUNCTION sugar_mfa_valid_box(value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $function$
    SELECT CASE WHEN jsonb_typeof(value)='object' THEN COALESCE(value->'v'='1'::jsonb
      AND value ?& ARRAY['v','iv','tag','data']
      AND value-ARRAY['v','iv','tag','data']='{}'::jsonb
      AND jsonb_typeof(value->'iv')='string' AND value->>'iv' ~ '^[a-f0-9]{24}$'
      AND jsonb_typeof(value->'tag')='string' AND value->>'tag' ~ '^[a-f0-9]{32}$'
      AND jsonb_typeof(value->'data')='string' AND value->>'data' ~ '^[a-f0-9]{64}$',false) ELSE false END
    $function$`)
  await q(`CREATE OR REPLACE FUNCTION sugar_mfa_valid_hashes(value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $function$
    SELECT COALESCE(cardinality(value)<=10 AND (cardinality(value)=0 OR array_ndims(value)=1)
      AND NOT EXISTS(SELECT 1 FROM unnest(value) hash WHERE hash IS NULL OR hash !~ '^[a-f0-9]{64}$')
      AND (SELECT count(DISTINCT hash)=cardinality(value) FROM unnest(value) hash),false)
    $function$`)
  await q(`CREATE TABLE IF NOT EXISTS mfa_credentials(
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    secret_box jsonb,
    pending_box jsonb,pending_id uuid,pending_expires_at timestamptz,pending_auth_version integer,
    last_step bigint NOT NULL DEFAULT -1 CHECK(last_step>=-1),
    recovery_hashes text[] NOT NULL DEFAULT '{}',
    challenge_hash text,challenge_expires_at timestamptz,challenge_auth_version integer,
    failures smallint NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),
    failures_since timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mfa_secret_box CHECK(secret_box IS NULL OR sugar_mfa_valid_box(secret_box)),
    CONSTRAINT mfa_recovery_hashes CHECK(sugar_mfa_valid_hashes(recovery_hashes)),
    CONSTRAINT mfa_enabled_state CHECK((enabled AND secret_box IS NOT NULL)
      OR (NOT enabled AND secret_box IS NULL AND cardinality(recovery_hashes)=0 AND last_step=-1)),
    CONSTRAINT mfa_pending_state CHECK(
      (pending_box IS NULL AND pending_id IS NULL AND pending_expires_at IS NULL AND pending_auth_version IS NULL)
      OR (NOT enabled AND pending_box IS NOT NULL AND sugar_mfa_valid_box(pending_box)
        AND pending_id IS NOT NULL AND pending_expires_at IS NOT NULL AND pending_auth_version IS NOT NULL AND pending_auth_version>=0)),
    CONSTRAINT mfa_challenge_state CHECK(
      (challenge_hash IS NULL AND challenge_expires_at IS NULL AND challenge_auth_version IS NULL)
      OR (enabled AND challenge_hash ~ '^[a-f0-9]{64}$' AND challenge_hash IS NOT NULL
        AND challenge_expires_at IS NOT NULL AND challenge_auth_version IS NOT NULL AND challenge_auth_version>=0))
  )`)
  await q('CREATE UNIQUE INDEX IF NOT EXISTS mfa_challenge_hash ON mfa_credentials(challenge_hash) WHERE challenge_hash IS NOT NULL')
}
