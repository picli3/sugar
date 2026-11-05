import crypto from 'node:crypto'
import { error } from '../shared/http.js'
import { attemptWindow, matchFactor, recordFailure } from './proofs.js'

const challengeDigest = token => crypto.createHash('sha256').update('sugar:mfa:login:v1:' + token).digest('hex')
const denied = (status = 401, message = 'mfaInvalid') => ({ status, message })
const unwrap = result => { if (result.status) error(result.status, result.message); return result.value }

// Only the authentication service calls this repository. The caller must have
// checked the password; the expected hash is rechecked under the account lock.
export function createMfaChallenges({ transaction, secretBox }) {
  const repository = {
    async issue(userId, expectedHash) {
      return unwrap(await transaction(async tx => {
        const user = (await tx('SELECT id,active,password_hash,auth_version FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0]
        if (!user?.active || typeof expectedHash !== 'string' || user.password_hash !== expectedHash) return denied()
        const state = (await tx('SELECT * FROM mfa_credentials WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        if (!state?.enabled) return { value: null }
        const now = (await tx('SELECT clock_timestamp() AS now')).rows[0].now, attempts = attemptWindow(state, now)
        if (attempts.failures >= 5) return denied(429, 'mfaRateLimited')
        const token = crypto.randomBytes(32).toString('base64url'), expiresAt = new Date(now.getTime() + 5 * 60 * 1000)
        await tx(`UPDATE mfa_credentials SET challenge_hash=$2,challenge_expires_at=$3,challenge_auth_version=$4,
          failures=$5,failures_since=$6 WHERE user_id=$1`, [userId, challengeDigest(token), expiresAt, user.auth_version, attempts.failures, attempts.since])
        return { value: { challenge: token, expiresAt: expiresAt.toISOString() } }
      }))
    },
    // Successful factor consumption and session creation must share this transaction.
    // A failed callback rolls both back; never return a session before COMMIT.
    async consume({ challenge, code, recovery = false }, onVerified) {
      if (typeof onVerified !== 'function') throw TypeError('MFA completion callback required')
      if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || typeof recovery !== 'boolean') error(401, 'mfaInvalid')
      const hash = challengeDigest(challenge)
      return unwrap(await transaction(async tx => {
        // Locate without locking, then use the global account -> MFA lock order and
        // recheck everything. No transaction ever locks MFA before its account.
        const located = (await tx('SELECT user_id FROM mfa_credentials WHERE challenge_hash=$1', [hash])).rows[0]
        if (!located) return denied()
        const user = (await tx('SELECT id,email,role,language,theme,active,auth_version FROM users WHERE id=$1 FOR UPDATE', [located.user_id])).rows[0]
        const state = (await tx('SELECT * FROM mfa_credentials WHERE user_id=$1 FOR UPDATE', [located.user_id])).rows[0]
        const now = (await tx('SELECT clock_timestamp() AS now')).rows[0].now
        if (!user?.active || !state?.enabled || state.challenge_hash !== hash || state.challenge_auth_version !== user.auth_version || state.challenge_expires_at <= now) return denied()
        const attempts = attemptWindow(state, now)
        if (attempts.failures >= 5) return denied(429, 'mfaRateLimited')
        const matched = matchFactor(secretBox, user.id, state, code, recovery, now)
        if (!matched) return recordFailure(tx, user.id, attempts, now)
        await tx(`UPDATE mfa_credentials SET challenge_hash=NULL,challenge_expires_at=NULL,challenge_auth_version=NULL,
          last_step=$2,recovery_hashes=$3,failures=0,failures_since=$4 WHERE user_id=$1`, [user.id, matched.lastStep, matched.recoveryHashes, now])
        const { active, ...identity } = user
        return { value: await onVerified(tx, identity) }
      }))
    },
  }
  return { ...repository,
    // Explicit lost-authenticator flow: a password-verified, unexpired login
    // challenge plus ONE unused recovery code can reset the factor. Requiring a
    // second code after login would lock someone using their last backup out.
    async recover(proof, onRecovered) {
      if (typeof onRecovered !== 'function') throw TypeError('MFA recovery callback required')
      return repository.consume({ ...proof, recovery: true }, async (tx, user) => {
        await tx(`UPDATE mfa_credentials SET enabled=false,secret_box=NULL,last_step=-1,recovery_hashes='{}',
          pending_box=NULL,pending_id=NULL,pending_expires_at=NULL,pending_auth_version=NULL,
          challenge_hash=NULL,challenge_expires_at=NULL,challenge_auth_version=NULL,failures=0,failures_since=clock_timestamp() WHERE user_id=$1`, [user.id])
        const version = (await tx('UPDATE users SET auth_version=auth_version+1 WHERE id=$1 RETURNING auth_version', [user.id])).rows[0].auth_version
        await tx('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [user.id])
        return onRecovered(tx, { ...user, auth_version: version })
      })
    },
  }
}
