import crypto from 'node:crypto'

export class GithubFailure extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status }
}
export const githubError = (code, status = 502) => new GithubFailure(code, status)
export const githubId = value => {
  if (!Number.isSafeInteger(value) || value < 1) throw githubError('GITHUB_RESPONSE_INVALID')
  return String(value)
}
export function userToken(value, refresh = false) {
  if (typeof value !== 'string' || value.length > 512 || !(refresh ? /^ghr_[A-Za-z0-9_]{20,508}$/ : /^ghu_[A-Za-z0-9_]{20,508}$/).test(value)) throw githubError('GITHUB_USER_TOKEN_INVALID', 409)
  return value
}
export const stateHash = value => crypto.createHash('sha256').update('sugar:github:oauth:v1:' + value).digest('hex')
export function authorizationRequest({ clientId, origin }) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(clientId)) throw githubError('GITHUB_CONFIG_REQUIRED', 503)
  githubCallbackUri(origin)
  const verifier = crypto.randomBytes(32).toString('base64url'), state = crypto.randomBytes(32).toString('base64url')
  const authorization = new URL('https://github.com/login/oauth/authorize')
  for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: githubCallbackUri(origin), state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'offline_access', prompt: 'select_account', allow_signup: 'false' })) authorization.searchParams.set(key, value)
  return { verifier, state, authorizationUrl: authorization.toString() }
}
export function tokenResult(value, now = Date.now()) {
  if (!value || Array.isArray(value) || value.error || value.token_type !== 'bearer' || value.scope !== '') throw githubError('GITHUB_AUTH_REJECTED', 400)
  const accessToken = userToken(value.access_token)
  const expiring = value.expires_in !== undefined || value.refresh_token !== undefined || value.refresh_token_expires_in !== undefined
  if (!expiring) return { accessToken, refreshToken: null, expiresAt: null, refreshExpiresAt: null }
  if (!Number.isSafeInteger(value.expires_in) || value.expires_in < 60 || value.expires_in > 86400 || !Number.isSafeInteger(value.refresh_token_expires_in) || value.refresh_token_expires_in < 60 || value.refresh_token_expires_in > 366 * 86400) throw githubError('GITHUB_RESPONSE_INVALID')
  return { accessToken, refreshToken: userToken(value.refresh_token, true), expiresAt: new Date(now + value.expires_in * 1000), refreshExpiresAt: new Date(now + value.refresh_token_expires_in * 1000) }
}

export function githubCallbackUri(origin) {
  let url
  try { url = new URL(origin) } catch { throw githubError('GITHUB_CONFIG_REQUIRED', 503) }
  if (url.origin !== origin || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw githubError('GITHUB_CONFIG_REQUIRED', 503)
  return origin + '/oauth/github/callback'
}
