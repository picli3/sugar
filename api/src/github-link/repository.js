import { githubError } from './protocol.js'

export function createGithubLinkRepository(q, transaction) {
  async function current(tx, userId, sessionId, write = true) {
    await tx('SELECT id FROM users WHERE id=$1 FOR ' + (write ? 'UPDATE' : 'KEY SHARE'), [userId])
    // A fresh statement after a waiter observes credential/account changes.
    const user = (await tx('SELECT id,role,active,auth_version,password_hash FROM users WHERE id=$1', [userId])).rows[0]
    if (!user?.active || !['dev','Admin'].includes(user.role)) throw githubError('GITHUB_ACCOUNT_REQUIRED', 403)
    if (sessionId && !(await tx('SELECT id FROM user_sessions WHERE id=$1 AND user_id=$2 AND auth_version=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()' + (write ? ' FOR UPDATE' : ''), [sessionId, userId, user.auth_version])).rowCount) throw githubError('GITHUB_SESSION_CHANGED', 409)
    return user
  }
  return {
    async status(userId) {
      return (await q('SELECT id,client_id,github_user_id,github_login,auth_version,expires_at,refresh_expires_at,refresh_started_at,(access_box IS NOT NULL) AS connected FROM github_links WHERE user_id=$1', [userId])).rows[0] || null
    },
    async begin(userId, sessionId, expectedHash, state) {
      return transaction(async tx => {
        const user = await current(tx, userId, sessionId)
        if (user.password_hash !== expectedHash) throw githubError('GITHUB_SESSION_CHANGED', 409)
        await tx('INSERT INTO github_links(user_id,id,client_id,auth_version) VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO NOTHING', [userId, state.id, state.clientId, user.auth_version])
        await tx(`INSERT INTO github_oauth_states(user_id,id,session_id,auth_version,client_id,state_hash,verifier_box,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '10 minutes')
          ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,session_id=excluded.session_id,auth_version=excluded.auth_version,
          client_id=excluded.client_id,state_hash=excluded.state_hash,verifier_box=excluded.verifier_box,expires_at=excluded.expires_at,claimed=false`,
        [userId, state.id, sessionId, user.auth_version, state.clientId, state.stateHash, state.verifierBox])
      })
    },
    async claim(userId, sessionId, digest, clientId) {
      return transaction(async tx => {
        const user = await current(tx, userId, sessionId)
        const state = (await tx(`UPDATE github_oauth_states SET claimed=true WHERE user_id=$1 AND session_id=$2 AND auth_version=$3
          AND state_hash=$4 AND client_id=$5 AND NOT claimed AND expires_at>clock_timestamp() RETURNING id,verifier_box`, [userId, sessionId, user.auth_version, digest, clientId])).rows[0]
        if (!state) throw githubError('GITHUB_OAUTH_STATE_INVALID', 400)
        return state
      })
    },
    async finish(userId, sessionId, stateId, clientId, identity, tokens) {
      return transaction(async tx => {
        const user = await current(tx, userId, sessionId)
        const prior = (await tx('SELECT * FROM github_links WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        const state = (await tx(`DELETE FROM github_oauth_states WHERE user_id=$1 AND id=$2 AND session_id=$3 AND auth_version=$4
          AND client_id=$5 AND claimed AND expires_at>clock_timestamp() RETURNING id`, [userId, stateId, sessionId, user.auth_version, clientId])).rows[0]
        if (!prior || !state) throw githubError('GITHUB_OAUTH_STATE_INVALID', 400)
        await tx(`UPDATE github_links SET id=$2,client_id=$3,auth_version=$4,github_user_id=$5,github_login=$6,
          access_box=$7,refresh_box=$8,expires_at=$9,refresh_expires_at=$10,refresh_nonce=NULL,refresh_started_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1`,
        [userId, stateId, clientId, user.auth_version, identity.id, identity.login, tokens.accessBox, tokens.refreshBox, tokens.expiresAt, tokens.refreshExpiresAt])
        return prior
      })
    },
    async discard(userId, stateId) {
      return transaction(async tx => {
        await tx('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId])
        const deleted = await tx('DELETE FROM github_oauth_states WHERE user_id=$1 AND id=$2', [userId, stateId])
        if (deleted.rowCount) await tx('DELETE FROM github_links WHERE user_id=$1 AND access_box IS NULL', [userId])
      })
    },
    async disconnect(userId, sessionId, expectedHash) {
      return transaction(async tx => {
        const user = await current(tx, userId, sessionId)
        if (user.password_hash !== expectedHash) throw githubError('GITHUB_SESSION_CHANGED', 409)
        const prior = (await tx('SELECT * FROM github_links WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        await tx('DELETE FROM github_oauth_states WHERE user_id=$1', [userId])
        await tx('DELETE FROM github_links WHERE user_id=$1', [userId])
        return prior || null
      })
    },
    // work is limited to credential refresh, provider reads/writes and job outcome
    // recording. Preserve a successful single-use refresh even if its next API call fails.
    async lease(userId, { sessionId, linkId } = {}, work) {
      const result = await transaction(async tx => {
        const user = await current(tx, userId, sessionId, false)
        const link = (await tx('SELECT * FROM github_links WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        if (!link?.access_box || link.auth_version !== user.auth_version || linkId && link.id !== linkId) throw githubError('GITHUB_NOT_CONNECTED', 409)
        try { return { value: await work(tx, user, link) } }
        catch (error) {
          if (['GITHUB_USER_REVOKED','GITHUB_AUTH_REJECTED','GITHUB_TOKEN_EXPIRED','GITHUB_IDENTITY_CHANGED'].includes(error.code)) {
            await tx('DELETE FROM github_oauth_states WHERE user_id=$1', [userId])
            await tx('DELETE FROM github_links WHERE user_id=$1', [userId])
          }
          return { error }
        }
      })
      if (result.error) throw result.error
      return result.value
    },
    async markRefresh(tx, userId, linkId, nonce) {
      await tx('UPDATE github_links SET refresh_nonce=$3,refresh_started_at=clock_timestamp() WHERE user_id=$1 AND id=$2', [userId, linkId, nonce])
    },
    async finishRefresh(userId, options, linkId, nonce, tokens) {
      return transaction(async tx => {
        const user = await current(tx, userId, options.sessionId, false)
        const link = (await tx('SELECT id,auth_version,refresh_nonce FROM github_links WHERE user_id=$1 FOR UPDATE', [userId])).rows[0]
        if (!link || link.id !== linkId || link.auth_version !== user.auth_version || link.refresh_nonce !== nonce) throw githubError('GITHUB_CONNECTION_CHANGED', 409)
        await tx(`UPDATE github_links SET access_box=$3,refresh_box=$4,expires_at=$5,refresh_expires_at=$6,
          refresh_nonce=NULL,refresh_started_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2`,
        [userId, linkId, tokens.accessBox, tokens.refreshBox, tokens.expiresAt, tokens.refreshExpiresAt])
      })
    },
    async abortRefresh(userId, linkId, nonce) {
      // The intent was committed BEFORE the provider call. A crash/DB outage
      // therefore blocks reuse of an ambiguously consumed refresh token.
      await q("UPDATE github_links SET refresh_started_at=clock_timestamp()-interval '2 minutes' WHERE user_id=$1 AND id=$2 AND refresh_nonce=$3", [userId, linkId, nonce])
    },
  }
}
