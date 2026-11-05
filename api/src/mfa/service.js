import bcrypt from 'bcryptjs'
import { error } from '../shared/http.js'
import { mfaObject, mfaCode, currentPassword } from './input.js'

export function createMfaService({ repository, users, secretBox, enrollmentEnabled = false, runCredential = task => task(), comparePassword = bcrypt.compare }) {
  async function freshPassword(user, value) {
    const password = currentPassword(value)
    return runCredential(async () => {
      const hash = await users.activePasswordHash(user.id)
      const valid = await comparePassword(password, hash || '$2a$12$Vj2QXOkjV9Siq9BW9.qboOQn215x4ge6Y/iDAOkGjQGI6ilzj3hli')
      if (!hash || !valid) error(400, 'mfaPasswordInvalid')
      return hash
    })
  }
  // Invalid factor requests do not log a still-authenticated browser out. A
  // revoked session is still rejected by the HTTP authentication middleware.
  async function authenticated(task) {
    try { return await task() }
    catch (e) { if (e.status === 401 && e.message === 'mfaInvalid') error(400, 'mfaInvalid'); throw e }
  }
  return {
    async status(user) {
      const state = await repository.status(user.id)
      return { enabled: state.enabled, recoveryCodesRemaining: state.remaining, keyAvailable: secretBox.available,
        canEnroll: user.role === 'Admin' && enrollmentEnabled && secretBox.available && !state.enabled }
    },
    async begin(user, sessionId, input) {
      mfaObject(input, ['currentPassword'])
      if (user.role !== 'Admin') error(403, 'mfaAdminRequired')
      if (!enrollmentEnabled) error(403, 'mfaEnrollmentDisabled')
      if (!secretBox.available) error(503, 'mfaKeyMissing')
      const expectedHash = await freshPassword(user, input.currentPassword)
      return authenticated(() => repository.enrollment.begin({ userId: user.id, sessionId, expectedHash }))
    },
    async confirm(user, sessionId, input) {
      mfaObject(input, ['enrollmentId','code'])
      if (user.role !== 'Admin') error(403, 'mfaAdminRequired')
      if (!enrollmentEnabled) error(403, 'mfaEnrollmentDisabled')
      const { code } = mfaCode(input)
      return authenticated(() => repository.enrollment.confirm({ userId: user.id, sessionId, enrollmentId: input.enrollmentId, code }))
    },
    async regenerate(user, sessionId, input) {
      mfaObject(input, ['currentPassword','code','recovery'])
      const proof = mfaCode(input), expectedHash = await freshPassword(user, input.currentPassword)
      return authenticated(() => repository.management.regenerate({ userId: user.id, sessionId, expectedHash, ...proof }))
    },
    async disable(user, sessionId, input) {
      mfaObject(input, ['currentPassword','code','recovery'])
      const proof = mfaCode(input), expectedHash = await freshPassword(user, input.currentPassword)
      return authenticated(() => repository.management.disable({ userId: user.id, sessionId, expectedHash, ...proof }))
    },
  }
}
