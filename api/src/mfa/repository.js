import { createMfaChallenges } from './challenges.js'
import { createMfaEnrollment } from './enrollment.js'
import { createMfaManagement } from './management.js'

export function createMfaRepository({ q, transaction, secretBox }) {
  return {
    challenges: createMfaChallenges({ transaction, secretBox }),
    enrollment: createMfaEnrollment({ transaction, secretBox }),
    management: createMfaManagement({ transaction, secretBox }),
    async status(id) {
      return (await q('SELECT enabled,cardinality(recovery_hashes)::int AS remaining FROM mfa_credentials WHERE user_id=$1', [id])).rows[0] || { enabled: false, remaining: 0 }
    },
  }
}
