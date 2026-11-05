import { matchTotp } from './totp.js'
import { matchesRecoveryCode } from './recovery.js'

export function attemptWindow(state, now) {
  const expired = now.getTime() - state.failures_since.getTime() >= 15 * 60 * 1000
  return { failures: expired ? 0 : state.failures, since: expired ? now : state.failures_since }
}

// Only call with locked, current account state. The caller persists consumption
// in its transaction, before returning any authenticated session or recovery codes.
export function matchFactor(secretBox, userId, state, code, recovery, now) {
  let step = null, recoveredHash = null
  if (recovery) {
    // Independent of seed encryption, so key loss cannot disable recovery codes.
    for (const candidate of state.recovery_hashes) if (matchesRecoveryCode(userId, code, candidate)) recoveredHash = candidate
  } else step = matchTotp(secretBox.decrypt(userId, state.secret_box), code, { now: now.getTime(), after: Number(state.last_step) })
  if (step === null && recoveredHash === null) return null
  return { lastStep: step ?? state.last_step, recoveryHashes: state.recovery_hashes.filter(value => value !== recoveredHash) }
}

export async function recordFailure(tx, userId, attempts, now) {
  const failures = attempts.failures + 1
  await tx('UPDATE mfa_credentials SET failures=$2,failures_since=$3 WHERE user_id=$1', [userId, failures, attempts.failures === 0 ? now : attempts.since])
  // Return, never throw here: the transaction must COMMIT its failure counter.
  return { status: failures >= 5 ? 429 : 401, message: failures >= 5 ? 'mfaRateLimited' : 'mfaInvalid' }
}
