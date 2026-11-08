import { defaultTotalStorage } from './config.js'

const syncMetadataFields = ['error','commit_sha','github_grant_id','github_owner_id','github_connection_id','github_installation_id','github_repository_id','github_allow_public']
const syncMetadataSql = `GREATEST(1024,${syncMetadataFields.map(field => `COALESCE(octet_length(${field}::text),0)`).join('+')})`

// Logical retained bytes. PostgreSQL indexes, WAL and free space are deliberately excluded.
export const usageSql = `SELECT
  (SELECT COALESCE(sum(octet_length(data)::bigint+octet_length(name)+octet_length(mime)),0) FROM images) AS images,
  (SELECT COALESCE(sum(bytes),0) FROM (
    SELECT octet_length(yaml)::bigint+octet_length(name) AS bytes FROM projects
    UNION ALL SELECT octet_length(name)::bigint+COALESCE(octet_length(catalog_preview::text),0) FROM blocks
    UNION ALL SELECT octet_length(data)::bigint+octet_length(name) FROM schematics
    UNION ALL SELECT 96::bigint FROM schematic_references
    UNION ALL SELECT octet_length(yaml)::bigint+octet_length(summary) FROM project_revisions
    UNION ALL SELECT octet_length(yaml)::bigint+octet_length(summary) FROM block_versions
    UNION ALL SELECT octet_length(before::text)::bigint+octet_length(after::text) FROM project_settings_history
  ) d) AS documents,
  (SELECT COALESCE(sum(octet_length(snapshot::text)::bigint+octet_length(response)+octet_length(focus)+octet_length(model)+COALESCE(octet_length(usage::text),0)),0) FROM project_analyses)
    +(SELECT COALESCE(sum(octet_length(payload_hash)::bigint+9+storage_bytes),0) FROM ai_calls) AS ai,
  (SELECT COALESCE(sum(octet_length(yaml)::bigint+COALESCE(octet_length(target_repository),0)+COALESCE(octet_length(target_branch),0)+${syncMetadataSql}),0) FROM sync_jobs) AS sync,
  (SELECT COALESCE(sum(octet_length(slug)::bigint+octet_length(name)+octet_length(name_key)+COALESCE(octet_length(icon),0)),0) FROM block_categories) AS categories,
  (SELECT COALESCE(sum(octet_length(key)::bigint+octet_length(value::text)),0) FROM settings)
    +(SELECT COALESCE(sum(octet_length(value::text)),0) FROM ai_quota_config)
    +(SELECT COALESCE(sum(octet_length(value::text)),0) FROM image_storage_config)
    +(SELECT COALESCE(sum(octet_length(value::text)),0) FROM document_storage_config)
    +(SELECT COALESCE(sum(octet_length(email)::bigint+octet_length(password_hash)+octet_length(role)+COALESCE(octet_length(display_name),0)),0) FROM users)
    +(SELECT COALESCE(sum(octet_length(project_id::text)::bigint+octet_length(user_id::text)+octet_length(role)),0) FROM project_members)
    +(SELECT COALESCE(sum(octet_length(id::text)::bigint+octet_length(user_id::text)),0) FROM user_sessions)
    +(SELECT COALESCE(sum(octet_length(image_id::text)::bigint+octet_length(resource_kind)+octet_length(resource_id::text)),0) FROM image_references)
    +(SELECT COALESCE(sum(octet_length(email)::bigint+octet_length(token_hash)+octet_length(language)),0) FROM pending_registrations)
    +(SELECT COALESCE(sum(octet_length(kind)::bigint+octet_length(email)+octet_length(token_hash)+COALESCE(octet_length(old_token_hash),0)+COALESCE(octet_length(old_email),0)+COALESCE(octet_length(user_id::text),0)+octet_length(language)),0) FROM account_actions)
    +(SELECT COALESCE(sum(256::bigint+COALESCE(octet_length(secret_box::text),0)+COALESCE(octet_length(pending_box::text),0)+octet_length(to_jsonb(recovery_hashes)::text)+COALESCE(octet_length(challenge_hash),0)),0) FROM mfa_credentials)
    +(SELECT count(*)*8192::bigint FROM github_links)
    +(SELECT count(*)*2048::bigint FROM github_oauth_states)
    +(SELECT count(*)*2048::bigint FROM github_project_grants) AS config`

const textBytes = field => `COALESCE(octet_length(value->>'${field}'),0)::bigint`
const jsonBytes = field => `CASE WHEN value->'${field}' IS NULL OR value->'${field}'='null'::jsonb THEN 0 ELSE octet_length((value->'${field}')::text)::bigint END`
const sizes = {
  schematic_references: ['96'],
  projects: ['yaml','name'].map(textBytes), blocks: [textBytes('name'), jsonBytes('catalog_preview')],
  project_revisions: ['yaml','summary'].map(textBytes), block_versions: ['yaml','summary'].map(textBytes),
  project_settings_history: ['before','after'].map(jsonBytes),
  project_analyses: [...['snapshot','usage'].map(jsonBytes), ...['response','focus','model'].map(textBytes)],
  // Reserve the longest call status (9 bytes) before billing, so a connection
  // test can settle at exact capacity or after limits are lowered meanwhile.
  ai_calls: [textBytes('payload_hash'), '9', `COALESCE((value->>'storage_bytes')::bigint,0)`],
  sync_jobs: [...['yaml','target_repository','target_branch'].map(textBytes), `GREATEST(1024,${syncMetadataFields.map(textBytes).join('+')})`],
  block_categories: ['slug','name','name_key','icon'].map(textBytes),
  settings: [textBytes('key'),jsonBytes('value')],
  ai_quota_config: [jsonBytes('value')], image_storage_config: [jsonBytes('value')],
  document_storage_config: [jsonBytes('value')], users: ['email','password_hash','role','display_name'].map(textBytes),
  project_members: ['project_id','user_id','role'].map(textBytes), user_sessions: ['id','user_id'].map(textBytes),
  image_references: ['image_id','resource_kind','resource_id'].map(textBytes),
  pending_registrations: ['email','token_hash','language'].map(textBytes),
  account_actions: ['kind','email','token_hash','old_token_hash','old_email','user_id','language'].map(textBytes),
  github_links: ['8192'], github_oauth_states: ['2048'], github_project_grants: ['2048'],
  mfa_credentials: ['256', ...['secret_box','pending_box','recovery_hashes'].map(jsonBytes), textBytes('challenge_hash')],
}
const sizeCases = Object.entries(sizes).map(([table, fields]) => `WHEN '${table}' THEN ${fields.join('+')}`).join('\n      ')
export const totalStorageTables = ['images', 'schematics', ...Object.keys(sizes)]
// Counted but never rejected: sign-in and account recovery must keep working while
// storage is full, and settled analyses were already admitted by their AI reservation.
const unenforced = ['user_sessions','account_actions','project_analyses','mfa_credentials']

export async function initTotalStorage(q, transaction) {
  await q('CREATE TABLE IF NOT EXISTS total_storage_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),value jsonb NOT NULL,version integer NOT NULL DEFAULT 1)')
  await q('INSERT INTO total_storage_config(id,value) VALUES(true,$1::jsonb) ON CONFLICT(id) DO NOTHING', [JSON.stringify(defaultTotalStorage)])
  await q('CREATE TABLE IF NOT EXISTS total_storage_usage(id boolean PRIMARY KEY DEFAULT true CHECK(id),images bigint NOT NULL,documents bigint NOT NULL,ai bigint NOT NULL,sync bigint NOT NULL,categories bigint NOT NULL,config bigint NOT NULL)')
  await q('CREATE TABLE IF NOT EXISTS total_storage_scopes(kind text NOT NULL,owner uuid NOT NULL,bytes bigint NOT NULL,PRIMARY KEY(kind,owner))')
  await transaction(async tx => {
    await tx(`LOCK TABLE ${totalStorageTables.join(',')} IN SHARE ROW EXCLUSIVE MODE`)
    await tx(`INSERT INTO total_storage_usage(id,images,documents,ai,sync,categories,config)
      SELECT true,images,documents,ai,sync,categories,config FROM (${usageSql}) used
      ON CONFLICT(id) DO UPDATE SET images=excluded.images,documents=excluded.documents,ai=excluded.ai,sync=excluded.sync,categories=excluded.categories,config=excluded.config`)
    await tx('DELETE FROM total_storage_scopes')
    await tx(`INSERT INTO total_storage_scopes(kind,owner,bytes)
      SELECT 'ai',actor,sum(bytes) FROM (
        SELECT author_id AS actor,octet_length(snapshot::text)::bigint+octet_length(response)+octet_length(focus)+octet_length(model)+COALESCE(octet_length(usage::text),0) AS bytes FROM project_analyses
        UNION ALL SELECT user_id,octet_length(payload_hash)::bigint+9+storage_bytes FROM ai_calls
      ) records GROUP BY actor ON CONFLICT(kind,owner) DO NOTHING`)
    await tx(`INSERT INTO total_storage_scopes(kind,owner,bytes)
      SELECT 'sync',record_id,sum(octet_length(yaml)::bigint+COALESCE(octet_length(target_repository),0)+COALESCE(octet_length(target_branch),0)+${syncMetadataSql})
      FROM sync_jobs GROUP BY record_id ON CONFLICT(kind,owner) DO NOTHING`)
    await tx(`CREATE OR REPLACE FUNCTION sugar_storage_row_bytes(kind text,value jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE AS $function$
      SELECT CASE kind ${sizeCases} ELSE 0 END
    $function$`)
    // Every write is counted so maintenance changes cannot drift the counters; only the
    // runtime role is rejected. Runs as a deferred constraint trigger: the shared usage row
    // is locked at COMMIT, after every feature lock, so lock order is global and acyclic.
    await tx(`CREATE OR REPLACE FUNCTION sugar_enforce_total_storage() RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE limits jsonb; fresh bigint := 0; prior bigint := 0; delta bigint; bucket text; scope_kind text; scope_owner uuid; scope_limit bigint; enforce boolean;
    BEGIN
      IF TG_OP<>'DELETE' THEN
        IF TG_TABLE_NAME='images' THEN fresh := octet_length(NEW.data)::bigint+octet_length(NEW.name)+octet_length(NEW.mime);
        ELSIF TG_TABLE_NAME='schematics' THEN fresh := octet_length(NEW.data)::bigint+octet_length(NEW.name);
        ELSE fresh := sugar_storage_row_bytes(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
      END IF;
      IF TG_OP<>'INSERT' THEN
        IF TG_TABLE_NAME='images' THEN prior := octet_length(OLD.data)::bigint+octet_length(OLD.name)+octet_length(OLD.mime);
        ELSIF TG_TABLE_NAME='schematics' THEN prior := octet_length(OLD.data)::bigint+octet_length(OLD.name);
        ELSE prior := sugar_storage_row_bytes(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
      END IF;
      delta := fresh-prior;
      IF delta=0 THEN RETURN NULL; END IF;
      enforce := delta>0 AND current_user='sugar_runtime' AND TG_TABLE_NAME NOT IN (${unenforced.map(table => `'${table}'`).join(',')});
      SELECT value INTO limits FROM total_storage_config WHERE id=true FOR SHARE;
      IF limits IS NULL THEN RAISE EXCEPTION 'Total storage configuration missing' USING ERRCODE='PZ002'; END IF;
      bucket := CASE WHEN TG_TABLE_NAME='images' THEN 'images'
        WHEN TG_TABLE_NAME IN ('projects','blocks','project_revisions','block_versions','project_settings_history','schematics','schematic_references') THEN 'documents'
        WHEN TG_TABLE_NAME IN ('project_analyses','ai_calls') THEN 'ai'
        WHEN TG_TABLE_NAME='sync_jobs' THEN 'sync'
        WHEN TG_TABLE_NAME='block_categories' THEN 'categories' ELSE 'config' END;
      UPDATE total_storage_usage SET
        images=images+CASE WHEN bucket='images' THEN delta ELSE 0 END,
        documents=documents+CASE WHEN bucket='documents' THEN delta ELSE 0 END,
        ai=ai+CASE WHEN bucket='ai' THEN delta ELSE 0 END,
        sync=sync+CASE WHEN bucket='sync' THEN delta ELSE 0 END,
        categories=categories+CASE WHEN bucket='categories' THEN delta ELSE 0 END,
        config=config+CASE WHEN bucket='config' THEN delta ELSE 0 END
      WHERE id=true AND (NOT enforce OR (
        images+documents+ai+sync+categories+config+delta <= (limits->>'platformBytes')::bigint
        AND (bucket<>'ai' OR ai+delta <= (limits->>'aiBytes')::bigint)
        AND (bucket<>'sync' OR sync+delta <= (limits->>'syncBytes')::bigint)
        AND (bucket<>'categories' OR categories+delta <= (limits->>'categoryBytes')::bigint)
        AND (bucket<>'config' OR config+delta <= (limits->>'configBytes')::bigint)));
      IF NOT FOUND THEN RAISE EXCEPTION 'Storage quota exhausted' USING ERRCODE='PZ001'; END IF;
      IF TG_TABLE_NAME IN ('project_analyses','ai_calls') THEN
        scope_kind := 'ai'; scope_limit := (limits->>'userAiBytes')::bigint;
        IF TG_TABLE_NAME='project_analyses' THEN
          IF TG_OP='DELETE' THEN scope_owner := OLD.author_id; ELSE scope_owner := NEW.author_id; END IF;
        ELSE
          IF TG_OP='DELETE' THEN scope_owner := OLD.user_id; ELSE scope_owner := NEW.user_id; END IF;
        END IF;
      ELSIF TG_TABLE_NAME='sync_jobs' THEN
        scope_kind := 'sync'; scope_limit := (limits->>'projectSyncBytes')::bigint;
        IF TG_OP='DELETE' THEN scope_owner := OLD.record_id; ELSE scope_owner := NEW.record_id; END IF;
      END IF;
      IF scope_kind IS NOT NULL THEN
        IF enforce AND delta>scope_limit THEN RAISE EXCEPTION 'Scoped storage quota exhausted' USING ERRCODE='PZ001'; END IF;
        INSERT INTO total_storage_scopes(kind,owner,bytes) VALUES(scope_kind,scope_owner,delta)
        ON CONFLICT(kind,owner) DO UPDATE SET bytes=total_storage_scopes.bytes+EXCLUDED.bytes
          WHERE NOT enforce OR total_storage_scopes.bytes+EXCLUDED.bytes<=scope_limit;
        IF NOT FOUND THEN RAISE EXCEPTION 'Scoped storage quota exhausted' USING ERRCODE='PZ001'; END IF;
      END IF;
      RETURN NULL;
    END $function$`)
    for (const table of totalStorageTables) {
      await tx(`DROP TRIGGER IF EXISTS sugar_total_storage_${table} ON ${table}`)
      await tx(`CREATE CONSTRAINT TRIGGER sugar_total_storage_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sugar_enforce_total_storage()`)
    }
  })
}
