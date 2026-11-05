import { loginProof, mfaObject } from '../mfa/input.js'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { loginInput } from '../security/limits.js'
import { error } from '../shared/http.js'
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
export const sessionLifetime = 7 * 24 * 60 * 60

export function createAuthService({ users, sessions, secret, runCredential = task => task(), comparePassword = bcrypt.compare, mfaChallenges }) {
  function identity(token, ignoreExpiration = false) {
    if (!token) error(401, 'Sesión requerida')
    let payload
    try { payload = jwt.verify(token, secret, { algorithms: ['HS256'], ignoreExpiration }) }
    catch (e) { error(401, e.name === 'TokenExpiredError' ? 'La sesión caducó. Vuelve a entrar.' : 'Sesión inválida') }
    if (!uuid(payload?.id) || !uuid(payload?.sid)) error(401, 'Sesión inválida')
    return { userId: payload.id, sessionId: payload.sid }
  }
  async function authenticateSession(token) {
    const { userId, sessionId } = identity(token)
    const user = await sessions.user(sessionId, userId)
    if (!user) error(401, 'Sesión inválida o caducada. Vuelve a entrar.')
    return { user, sessionId }
  }
  return {
    async login(input) {
      const { email, password } = loginInput(input)
      return runCredential(async () => {
        const user = await users.findActiveByEmail(email)
        // Unknown/deactivated accounts perform the same bcrypt cost as a known account.
        const valid = await comparePassword(password, user?.password_hash || '$2a$12$Vj2QXOkjV9Siq9BW9.qboOQn215x4ge6Y/iDAOkGjQGI6ilzj3hli')
        if (!user || !valid) error(401, 'Credenciales inválidas')
        const challenge = await mfaChallenges?.issue(user.id, user.password_hash)
        if (challenge) return { mfaRequired: true, ...challenge }
        const sid = crypto.randomUUID(), expiresAt = new Date(Date.now() + sessionLifetime * 1000)
        if (!(await sessions.create(sid, user.id, user.password_hash, expiresAt))) error(401, 'Credenciales inválidas')
        return {
          token: jwt.sign({ id: user.id, sid }, secret, { algorithm: 'HS256', expiresIn: sessionLifetime }),
          user: { id: user.id, email: user.email, role: user.role, language: user.language, theme: user.theme },
        }
      })
    },
    async completeMfa(input) {
      if (!mfaChallenges) error(401, 'mfaInvalid')
      return mfaChallenges.consume(loginProof(input), async (tx, user) => {
        const sid = crypto.randomUUID(), expiresAt = new Date(Date.now() + sessionLifetime * 1000)
        if (!(await sessions.createVerified(tx, sid, user.id, user.auth_version, expiresAt))) error(401, 'mfaInvalid')
        return {
          token: jwt.sign({ id: user.id, sid }, secret, { algorithm: 'HS256', expiresIn: sessionLifetime }),
          user: { id: user.id, email: user.email, role: user.role, language: user.language, theme: user.theme },
        }
      })
    },
    async recoverMfa(input) {
      if (!mfaChallenges) error(401, 'mfaInvalid')
      mfaObject(input, ['challenge','code'])
      const proof = loginProof({ ...input, recovery: true })
      return mfaChallenges.recover(proof, async (tx, user) => {
        const sid = crypto.randomUUID(), expiresAt = new Date(Date.now() + sessionLifetime * 1000)
        if (!(await sessions.createAfterRecovery(tx, sid, user.id, user.auth_version, expiresAt))) error(401, 'mfaInvalid')
        return {
          token: jwt.sign({ id: user.id, sid }, secret, { algorithm: 'HS256', expiresIn: sessionLifetime }),
          user: { id: user.id, email: user.email, role: user.role, language: user.language, theme: user.theme },
        }
      })
    },
    authenticateSession,
    authenticate: async token => (await authenticateSession(token)).user,
    async logout(token) {
      let claim
      try { claim = identity(token, true) } catch (e) { if (e.status === 401) return; throw e }
      await sessions.revoke(claim.sessionId, claim.userId)
    },
    listSessions: (user, currentId) => sessions.list(user.id, currentId),
    revokeOthers: (user, currentId) => sessions.revokeOthers(user.id, currentId),
    async revokeSession(user, id) {
      if (!uuid(id) || !(await sessions.revoke(id, user.id))) error(404, 'Sesión no encontrada')
    },
  }
}
