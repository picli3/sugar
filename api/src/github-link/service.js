import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { githubError, authorizationRequest, stateHash } from './protocol.js'

const inputObject = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw githubError('GITHUB_INPUT_INVALID', 400); return value }
const scope = (userId, linkId, purpose) => ({ userId, linkId, purpose })
export function createGithubLinkService({ repository, users, config, client, runCredential = task => task(), runProvider = (_id, task) => task(), clock = Date.now }) {
  const configured = () => { if (!config.available) throw githubError('GITHUB_CONFIG_REQUIRED', 503) }
  function tokenBoxes(userId, id, tokens) {
    return { accessBox: config.box.encrypt(scope(userId, id, 'access'), tokens.accessToken), refreshBox: tokens.refreshToken ? config.box.encrypt(scope(userId, id, 'refresh'), tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt, refreshExpiresAt: tokens.refreshExpiresAt }
  }
  async function password(user, input) {
    const value = input.currentPassword
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024) throw githubError('GITHUB_INPUT_INVALID', 400)
    return runCredential(async () => {
      const hash = await users.activePasswordHash(user.id)
      const valid = await bcrypt.compare(value, hash || '$2a$12$Vj2QXOkjV9Siq9BW9.qboOQn215x4ge6Y/iDAOkGjQGI6ilzj3hli')
      if (!hash || !valid) throw githubError('GITHUB_PASSWORD_INVALID', 400)
      return hash
    })
  }
  async function revoke(token) { try { await client.revoke(token); return true } catch { return false } }
  async function withCredential(userId, options, task) {
    configured()
    return runProvider(userId, async () => {
      for (let pass = 0; pass < 2; pass++) {
        const result = await repository.lease(userId, options, async (tx, user, link) => {
          if (link.client_id !== config.clientId) throw githubError('GITHUB_CONNECTION_CHANGED', 409)
          if (link.refresh_nonce) throw githubError(link.refresh_started_at.getTime() + 60000 < clock() ? 'GITHUB_REFRESH_INTERRUPTED' : 'GITHUB_REFRESH_IN_PROGRESS', link.refresh_started_at.getTime() + 60000 < clock() ? 409 : 429)
          const token = config.box.decrypt(scope(userId, link.id, 'access'), link.access_box)
          if (link.expires_at && link.expires_at.getTime() <= clock() + (pass === 0 ? 60000 : 0)) {
            if (pass || !link.refresh_box || !link.refresh_expires_at || link.refresh_expires_at.getTime() <= clock()) throw githubError('GITHUB_TOKEN_EXPIRED', 409)
            const refresh = config.box.decrypt(scope(userId, link.id, 'refresh'), link.refresh_box), nonce = crypto.randomUUID()
            await repository.markRefresh(tx, userId, link.id, nonce)
            return { refresh: { token: refresh, nonce, id: link.id, githubId: link.github_user_id } }
          }
          return { done: true, value: await task({ tx, user, link, token }) }
        })
        if (result.done) return result.value
        const claim = result.refresh
        try {
          const tokens = await client.refresh(claim.token)
          if ((await client.identity(tokens.accessToken)).id !== claim.githubId) throw githubError('GITHUB_IDENTITY_CHANGED', 409)
          await repository.finishRefresh(userId, options, claim.id, claim.nonce, tokenBoxes(userId, claim.id, tokens))
        } catch (error) {
          await repository.abortRefresh(userId, claim.id, claim.nonce)
          throw error
        }
      }
      throw githubError('GITHUB_REFRESH_INTERRUPTED', 409)
    })
  }

  return {
    withCredential,
    async status(user) {
      const link = await repository.status(user.id)
      return { configured: config.available, canConnect: config.available && config.connectEnabled && ['dev','Admin'].includes(user.role),
        connected: link?.connected === true, canDisconnect: !!link, connectionId: link?.connected ? link.id : null,
        account: link?.connected ? { id: link.github_user_id, login: link.github_login } : null, expiresAt: link?.expires_at || null,
        needsReauthorization: !!link?.connected && (link.client_id !== config.clientId || !!link.refresh_expires_at && link.refresh_expires_at.getTime() <= clock() || !!link.refresh_started_at && link.refresh_started_at.getTime() + 60000 < clock()) }
    },
    async begin(user, sessionId, input) {
      inputObject(input, ['currentPassword']); configured()
      if (!config.connectEnabled) throw githubError('GITHUB_CONNECT_DISABLED', 403)
      if (!['dev','Admin'].includes(user.role)) throw githubError('GITHUB_ACCOUNT_REQUIRED', 403)
      const expectedHash = await password(user, input), id = crypto.randomUUID(), auth = authorizationRequest(config)
      await repository.begin(user.id, sessionId, expectedHash, { id, clientId: config.clientId, stateHash: stateHash(auth.state), verifierBox: config.box.encrypt(scope(user.id, id, 'verifier'), auth.verifier) })
      return { authorizationUrl: auth.authorizationUrl }
    },
    async complete(user, sessionId, input) {
      inputObject(input, ['code','state']); configured()
      if (!config.connectEnabled) throw githubError('GITHUB_CONNECT_DISABLED', 403)
      if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || typeof input.code !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(input.code)) throw githubError('GITHUB_INPUT_INVALID', 400)
      return runProvider(user.id, async () => {
        const state = await repository.claim(user.id, sessionId, stateHash(input.state), config.clientId)
        let tokens, committed = false
        try {
          tokens = await client.exchange({ code: input.code, verifier: config.box.decrypt(scope(user.id, state.id, 'verifier'), state.verifier_box) })
          const identity = await client.identity(tokens.accessToken)
          const previous = await repository.finish(user.id, sessionId, state.id, config.clientId, identity, tokenBoxes(user.id, state.id, tokens))
          committed = true
          let remoteRevocationPending = false
          if (previous.access_box) {
            try {
              const old = config.box.decrypt(scope(user.id, previous.id, 'access'), previous.access_box)
              if (old !== tokens.accessToken) remoteRevocationPending = previous.client_id !== config.clientId || !(await revoke(old))
            } catch { remoteRevocationPending = true }
          }
          return { connected: true, account: identity, remoteRevocationPending }
        } finally {
          if (!committed) {
            await repository.discard(user.id, state.id)
            if (tokens) await revoke(tokens.accessToken)
          }
        }
      })
    },
    async disconnect(user, sessionId, input) {
      inputObject(input, ['currentPassword'])
      const hash = await password(user, input), previous = await repository.disconnect(user.id, sessionId, hash)
      let remoteRevoked = null
      if (previous?.access_box) {
        remoteRevoked = false
        if (config.available && previous.client_id === config.clientId) {
          try { remoteRevoked = await runProvider(user.id, () => revoke(config.box.decrypt(scope(user.id, previous.id, 'access'), previous.access_box))) } catch { /* local disconnect already committed */ }
        }
      }
      return { disconnected: true, remoteRevoked }
    },
    installations: (user, sessionId) => withCredential(user.id, { sessionId }, ({ token }) => client.installations(token)),
    repositories: (user, sessionId, installationId) => withCredential(user.id, { sessionId }, ({ token }) => client.repositories(token, installationId)),
  }
}
