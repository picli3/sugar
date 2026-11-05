export const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)

export async function lockCurrentAccount(tx, userId, sessionId, verified = false) {
  const user = (await tx('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0]
  if (!user?.active) return null
  // Check again AFTER the account lock and lock the current session: a logout
  // already committed must never be overwritten by a session upgrade.
  const session = (await tx(`SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL
    AND expires_at>clock_timestamp() AND auth_version=$3 AND (NOT $4 OR mfa_verified) FOR UPDATE`, [sessionId, userId, user.auth_version, verified])).rows[0]
  return session ? user : null
}
