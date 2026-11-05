// Database guard also protects an older API replica from minting a password-only
// session after enrollment. Existing unenrolled sessions remain usable.
export async function initMfaSessionDb(q) {
  await q('ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS mfa_verified boolean NOT NULL DEFAULT false')
  await q(`CREATE OR REPLACE FUNCTION sugar_guard_mfa_session() RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      PERFORM id FROM users WHERE id=NEW.user_id FOR UPDATE;
      IF NOT NEW.mfa_verified AND EXISTS(SELECT 1 FROM mfa_credentials WHERE user_id=NEW.user_id AND enabled) THEN
        RAISE EXCEPTION 'Second factor required' USING ERRCODE='PZ003';
      END IF;
      RETURN NEW;
    END $function$`)
  await q('DROP TRIGGER IF EXISTS sugar_mfa_session_guard ON user_sessions')
  await q(`CREATE TRIGGER sugar_mfa_session_guard BEFORE INSERT OR UPDATE OF user_id,mfa_verified
    ON user_sessions FOR EACH ROW EXECUTE FUNCTION sugar_guard_mfa_session()`)
}
