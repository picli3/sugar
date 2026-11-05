import crypto from 'node:crypto'
import { error } from '../shared/http.js'
import { generateSecret, matchTotp, enrollmentUri } from './totp.js'
import { generateRecoveryCodes } from './recovery.js'
import { attemptWindow, recordFailure } from './proofs.js'
import { lockCurrentAccount, validId } from './accounts.js'

const denied = (status = 401, message = 'mfaInvalid') => ({ status, message })
const unwrap = result => { if (result.status) error(result.status, result.message); return result.value }
// Internal enrollment foundation; no HTTP adapter exposes these operations yet.
export function createMfaEnrollment({ transaction, secretBox }) {
  return {
    async begin({ userId, sessionId, expectedHash }) {
      if (!validId(userId) || !validId(sessionId)) error(401, 'mfaInvalid')
      return unwrap(await transaction(async tx => {
        const user = await lockCurrentAccount(tx, userId, sessionId)
        if (!user || typeof expectedHash !== 'string' || user.password_hash !== expectedHash) return denied()
        if (user.role !== 'Admin') return denied(403, 'mfaAdminRequired')
        if (!secretBox.available) return denied(503, 'mfaKeyMissing')
        await tx('INSERT INTO mfa_credentials(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING', [user.id])
        const state = (await tx('SELECT * FROM mfa_credentials WHERE user_id=$1 FOR UPDATE', [user.id])).rows[0]
        if (state.enabled) return denied(409, 'mfaAlreadyEnabled')
        const now = (await tx('SELECT clock_timestamp() AS now')).rows[0].now, attempts = attemptWindow(state, now)
        if (attempts.failures >= 5) return denied(429, 'mfaRateLimited')
        const secret = generateSecret(), enrollmentId = crypto.randomUUID(), expiresAt = new Date(now.getTime() + 10 * 60 * 1000)
        await tx(`UPDATE mfa_credentials SET pending_box=$2,pending_id=$3,pending_expires_at=$4,pending_auth_version=$5,
          failures=$6,failures_since=$7 WHERE user_id=$1`, [user.id, secretBox.encrypt(user.id, secret), enrollmentId, expiresAt, user.auth_version, attempts.failures, attempts.since])
        // Legacy addresses containing ':' cannot be represented in an OTP label.
        const label = typeof user.email === 'string' && user.email.length <= 254 && !/[:\x00-\x1f\x7f]/.test(user.email) ? user.email : user.id
        return { value: { enrollmentId, secret, uri: enrollmentUri(secret, label), expiresAt: expiresAt.toISOString() } }
      }))
    },
    async confirm({ userId, sessionId, enrollmentId, code }) {
      if (![userId, sessionId, enrollmentId].every(validId)) error(401, 'mfaInvalid')
      return unwrap(await transaction(async tx => {
        const user = await lockCurrentAccount(tx, userId, sessionId)
        if (!user) return denied()
        if (user.role !== 'Admin') return denied(403, 'mfaAdminRequired')
        const state = (await tx('SELECT * FROM mfa_credentials WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        const now = (await tx('SELECT clock_timestamp() AS now')).rows[0].now
        if (!state || state.enabled || state.pending_id !== enrollmentId || state.pending_auth_version !== user.auth_version || state.pending_expires_at <= now) return denied()
        const attempts = attemptWindow(state, now)
        if (attempts.failures >= 5) return denied(429, 'mfaRateLimited')
        const step = matchTotp(secretBox.decrypt(userId, state.pending_box), code, { now: now.getTime() })
        if (step === null) return recordFailure(tx, userId, attempts, now)
        const recovery = generateRecoveryCodes(userId)
        await tx(`UPDATE mfa_credentials SET enabled=true,secret_box=pending_box,last_step=$2,recovery_hashes=$3,
          pending_box=NULL,pending_id=NULL,pending_expires_at=NULL,pending_auth_version=NULL,
          challenge_hash=NULL,challenge_expires_at=NULL,challenge_auth_version=NULL,failures=0,failures_since=$4 WHERE user_id=$1`, [userId, step, recovery.hashes, now])
        const version = (await tx('UPDATE users SET auth_version=auth_version+1 WHERE id=$1 RETURNING auth_version', [userId])).rows[0].auth_version
        await tx('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [userId, sessionId])
        await tx('UPDATE user_sessions SET auth_version=$3,mfa_verified=true WHERE user_id=$1 AND id=$2', [userId, sessionId, version])
        // Plain codes are returned once, after COMMIT, and never stored in history.
        return { value: { recoveryCodes: recovery.codes } }
      }))
    },
  }
}
