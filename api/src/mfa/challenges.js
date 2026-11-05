import crypto from 'node:crypto'
import { error } from '../shared/http.js'
import { matchTotp } from './totp.js'
import { matchesRecoveryCode } from './recovery.js'

const challengeDigest = token => crypto.createHash('sha256').update('sugar:mfa:login:v1:' + token).digest('hex')
const failureWindowMs = 15 * 60 * 1000
export function attemptWindow(state, now) {
  const expired = now.getTime() - state.failures_since.getTime() >= failureWindowMs
  return { failures: expired ? 0 : state.failures, since: expired ? now : state.failures_since }
}
const denied = (status = 401, message = 'mfaInvalid') => ({ status, message })
const unwrap = result => { if (result.status) error(result.status, result.message); return result.value }

// Internal repository foundation, not exposed by HTTP yet. The caller must have
// checked the password; the expected hash is rechecked under the account lock.
export function createMfaChallenges({ transaction, secretBox }) {
  return {
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
        let step = null, recoveredHash = null
        if (recovery) {
          // Recovery must remain available if the dedicated encryption key is lost.
          for (const candidate of state.recovery_hashes) if (matchesRecoveryCode(user.id, code, candidate)) recoveredHash = candidate
        } else step = matchTotp(secretBox.decrypt(user.id, state.secret_box), code, { now: now.getTime(), after: Number(state.last_step) })
        if (step === null && recoveredHash === null) {
          const failures = attempts.failures + 1
          await tx('UPDATE mfa_credentials SET failures=$2,failures_since=$3 WHERE user_id=$1', [user.id, failures, attempts.failures === 0 ? now : attempts.since])
          // Return the failure so COMMIT preserves its counter. Throwing inside
          // this transaction would silently roll brute-force protection back.
          return failures >= 5 ? denied(429, 'mfaRateLimited') : denied()
        }
        await tx(`UPDATE mfa_credentials SET challenge_hash=NULL,challenge_expires_at=NULL,challenge_auth_version=NULL,
          last_step=$2,recovery_hashes=$3,failures=0,failures_since=$4 WHERE user_id=$1`, [user.id, step ?? state.last_step, state.recovery_hashes.filter(value => value !== recoveredHash), now])
        const { active, ...identity } = user
        return { value: await onVerified(tx, identity) }
      }))
    },
  }
}
