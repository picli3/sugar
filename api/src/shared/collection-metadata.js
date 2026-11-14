// Persist listing metadata so browsing never transfers diagram or image contents.
export async function initCollectionMetadata(q) {
  for (const [table, content] of [['projects', 'yaml'], ['images', 'data']]) {
    await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS updated_at timestamptz`)
    await q(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS size_bytes integer
      GENERATED ALWAYS AS (octet_length(${content})) STORED`)
  }
  await q(`UPDATE projects p SET updated_at=GREATEST(p.created_at,
    (SELECT max(created_at) FROM project_revisions WHERE project_id=p.id),
    (SELECT max(created_at) FROM project_settings_history WHERE project_id=p.id))
    WHERE updated_at IS NULL`)
  await q('UPDATE images SET updated_at=created_at WHERE updated_at IS NULL')
  await q(`CREATE OR REPLACE FUNCTION sugar_collection_modified() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      NEW.updated_at := CASE WHEN TG_OP='INSERT' THEN NEW.created_at ELSE clock_timestamp() END;
      RETURN NEW;
    END $function$`)
  for (const [table, fields] of [['projects', 'name,yaml,visibility,sync_repository,sync_branch,deleted_at'],
    ['images', 'name,mime,data,scope,owner_id,deleted_at']]) {
    await q(`ALTER TABLE ${table} ALTER COLUMN updated_at SET NOT NULL`)
    await q(`DROP TRIGGER IF EXISTS sugar_collection_modified ON ${table}`)
    await q(`CREATE TRIGGER sugar_collection_modified BEFORE INSERT OR UPDATE OF ${fields} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION sugar_collection_modified()`)
    for (const field of ['updated_at', 'size_bytes']) {
      await q(`CREATE INDEX IF NOT EXISTS ${table}_browse_${field} ON ${table}(${field},id) WHERE deleted_at IS NULL`)
    }
  }
}
