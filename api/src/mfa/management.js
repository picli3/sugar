import { error } from '../shared/http.js'
import { generateRecoveryCodes } from './recovery.js'
import { lockCurrentAccount, validId, rotateMfaSession } from './accounts.js'
import { attemptWindow, matchFactor, recordFailure } from './proofs.js'

const denied = (status = 401, message = 'mfaInvalid') => ({ status, message })

// Self-service only, using a fresh preverified password plus a factor. Neither
// an Admin nor a request flag can target another account through this repository.
export function createMfaManagement({ transaction, secretBox }) {
  async function change(action, { userId, sessionId, expectedHash, code, recovery = false }) {
    if (!validId(userId) || !validId(sessionId) || typeof recovery !== 'boolean') error(401, 'mfaInvalid')
    const result = await transaction(async tx => {
      const user = await lockCurrentAccount(tx, userId, sessionId, true)
      if (!user || typeof expectedHash !== 'string' || user.password_hash !== expectedHash) return denied()
      const state = (await tx('SELECT * FROM mfa_credentials WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
      if (!state?.enabled) return denied(409, 'mfaNotEnabled')
      const now = (await tx('SELECT clock_timestamp() AS now')).rows[0].now, attempts = attemptWindow(state, now)
      if (attempts.failures >= 5) return denied(429, 'mfaRateLimited')
      const matched = matchFactor(secretBox, userId, state, code, recovery, now)
      if (!matched) return recordFailure(tx, userId, attempts, now)
      const fresh = action === 'regenerate' ? generateRecoveryCodes(userId) : null
      await tx(`UPDATE mfa_credentials SET enabled=$2,secret_box=CASE WHEN $2 THEN secret_box ELSE NULL END,
        last_step=$3,recovery_hashes=$4,pending_box=NULL,pending_id=NULL,pending_expires_at=NULL,pending_auth_version=NULL,
        challenge_hash=NULL,challenge_expires_at=NULL,challenge_auth_version=NULL,failures=0,failures_since=$5 WHERE user_id=$1`,
      [userId, action === 'regenerate', fresh ? matched.lastStep : -1, fresh ? fresh.hashes : [], now])
      const version = (await tx('UPDATE users SET auth_version=auth_version+1 WHERE id=$1 RETURNING auth_version', [userId])).rows[0].auth_version
      const session = await rotateMfaSession(tx, userId, version, action === 'regenerate', now)
      return { value: fresh ? { recoveryCodes: fresh.codes, session } : { enabled: false, session } }
    })
    if (result.status) error(result.status, result.message)
    return result.value
  }
  return {
    regenerate: input => change('regenerate', input),
    disable: input => change('disable', input),
  }
}
