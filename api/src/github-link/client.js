import { performance } from 'node:perf_hooks'
import crypto from 'node:crypto'
import { githubError, GithubFailure, githubId, userToken, tokenResult, githubCallbackUri } from './protocol.js'
const version = '2026-03-10', maxBodyBytes = 4 * 1024 * 1024
const validRepository = value => typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
const validId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
const validBranch = value => typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes('..') && !value.startsWith('/') && !value.endsWith('/')

// No configurable provider host, redirects, installation-token fallback or HTTP
// retries. Only the future account-link/sync services may invoke this client.
export function createGithubClient({ clientId, clientSecret, origin, request = fetch, timeoutMs = 10000, clock = Date.now, budgetClock = () => performance.now() }) {
  const configured = () => { if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(clientId) || typeof clientSecret !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(clientSecret)) throw githubError('GITHUB_CONFIG_REQUIRED', 503) }
  async function call(url, { token, method = 'GET', body, basic = false, deadline = budgetClock() + timeoutMs } = {}) {
    const controller = new AbortController(), remaining = deadline - budgetClock()
    if (remaining <= 0) throw githubError('GITHUB_TIMEOUT', 504)
    let timer, reader, response
    const timed = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(githubError('GITHUB_TIMEOUT', 504)) }, remaining) })
    try {
      return await Promise.race([timed, (async () => {
        const authorization = basic ? 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64') : token ? 'Bearer ' + userToken(token) : undefined
        const res = response = await request(url, { method, redirect: 'error', signal: controller.signal,
          headers: { Accept: url.startsWith('https://github.com/') ? 'application/json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': version, 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
        if (res.status === 204) return { status: 204, value: null }
        if (!res.ok) {
          if (res.status === 401) throw githubError('GITHUB_USER_REVOKED', 409)
          if (res.status === 429 || res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))) throw githubError('GITHUB_RATE_LIMITED', 429)
          if (res.status === 403) throw githubError('GITHUB_ACCESS_DENIED', 403)
          if (res.status === 404) return { status: 404, value: null }
          throw githubError('GITHUB_UNAVAILABLE', 502)
        }
        if (!res.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw githubError('GITHUB_RESPONSE_INVALID')
        const length = res.headers.get('content-length')
        if (length && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) throw githubError('GITHUB_RESPONSE_TOO_LARGE', 502)
        reader = res.body?.getReader()
        if (!reader) throw githubError('GITHUB_RESPONSE_INVALID')
        const chunks = []; let bytes = 0
        while (true) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > maxBodyBytes) throw githubError('GITHUB_RESPONSE_TOO_LARGE', 502)
          chunks.push(Buffer.from(part.value))
        }
        let value
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw githubError('GITHUB_RESPONSE_INVALID') }
        return { status: res.status, value }
      })()])
    } catch (e) {
      if (e instanceof GithubFailure) throw e
      throw githubError('GITHUB_UNAVAILABLE', 502)
    } finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); else if (response?.body) void response.body.cancel().catch(() => {}) }
  }
  const api = async (path, token, deadline) => {
    const result = await call('https://api.github.com' + path, { token, deadline })
    if (result.status === 404) throw githubError('GITHUB_ACCESS_DENIED', 403)
    return result.value
  }
  async function pages(path, key, token, deadline, find) {
    const records = []
    for (let page = 1; page <= 20; page++) {
      const value = await api(path + `?per_page=50&page=${page}`, token, deadline), rows = value?.[key]
      if (!Array.isArray(rows) || rows.length > 50 || !Number.isSafeInteger(value.total_count) || value.total_count < 0) throw githubError('GITHUB_RESPONSE_INVALID')
      records.push(...rows)
      const found = find && rows.find(find)
      if (found) return found
      if (rows.length < 50 || records.length >= value.total_count) return find ? null : records
    }
    throw githubError('GITHUB_CATALOG_TOO_LARGE', 413)
  }
  const installation = row => {
    const id = githubId(row?.id), accountId = githubId(row?.account?.id)
    if (typeof row.account.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(row.account.login)) throw githubError('GITHUB_RESPONSE_INVALID')
    return { id, accountId, login: row.account.login, writable: row.permissions?.contents === 'write' && row.suspended_at === null }
  }
  const repository = row => {
    const id = githubId(row?.id), ownerId = githubId(row?.owner?.id)
    if (!validRepository(row.full_name) || typeof row.default_branch !== 'string' || !validBranch(row.default_branch) || typeof row.private !== 'boolean') throw githubError('GITHUB_RESPONSE_INVALID')
    return { id, ownerId, name: row.full_name, defaultBranch: row.default_branch, private: row.private,
      writable: row.permissions?.push === true && row.archived === false && row.disabled === false }
  }
  async function authorize(token, target, deadline) {
    if (!validId(target?.installationId) || !validId(target.repositoryId) || !validRepository(target.repository) || !validBranch(target.branch)) throw githubError('GITHUB_TARGET_INVALID', 400)
    const rawInstall = await pages('/user/installations', 'installations', token, deadline, row => String(row?.id) === target.installationId)
    if (!rawInstall) throw githubError('GITHUB_ACCESS_DENIED', 403)
    const grant = installation(rawInstall)
    if (!grant.writable) throw githubError('GITHUB_ACCESS_DENIED', 403)
    const rawRepo = await pages(`/user/installations/${target.installationId}/repositories`, 'repositories', token, deadline, row => String(row?.id) === target.repositoryId)
    if (!rawRepo) throw githubError('GITHUB_ACCESS_DENIED', 403)
    const repo = repository(rawRepo)
    if (!repo.writable || repo.ownerId !== grant.accountId || repo.name.toLowerCase() !== target.repository.toLowerCase()) throw githubError('GITHUB_ACCESS_DENIED', 403)
    const branch = await call(`https://api.github.com/repos/${repo.name}/branches/${encodeURIComponent(target.branch)}`, { token, deadline })
    if (branch.status === 404) throw githubError('GITHUB_BRANCH_MISSING', 409)
    if (branch.value?.name !== target.branch) throw githubError('GITHUB_RESPONSE_INVALID')
    return { ...target, repository: repo.name, private: repo.private }
  }
  return {
    async exchange({ code, verifier }) {
      configured()
      const redirectUri = githubCallbackUri(origin)
      if (typeof code !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(code) || typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw githubError('GITHUB_AUTH_REJECTED', 400)
      const result = await call('https://github.com/login/oauth/access_token', { method: 'POST', body: { client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri } })
      return tokenResult(result.value, clock())
    },
    async refresh(token) {
      configured()
      const result = await call('https://github.com/login/oauth/access_token', { method: 'POST', body: { client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: userToken(token, true) } })
      return tokenResult(result.value, clock())
    },
    async revoke(token) {
      configured()
      userToken(token)
      const result = await call(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, { method: 'DELETE', basic: true, body: { access_token: token } })
      if (![204,404].includes(result.status)) throw githubError('GITHUB_UNAVAILABLE')
    },
    async identity(token) {
      const value = await api('/user', token)
      const id = githubId(value?.id)
      if (value.type !== 'User' || typeof value.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(value.login)) throw githubError('GITHUB_RESPONSE_INVALID')
      return { id, login: value.login }
    },
    async installations(token) { return (await pages('/user/installations', 'installations', token, budgetClock() + timeoutMs)).map(installation) },
    async repositories(token, id) {
      if (!validId(id)) throw githubError('GITHUB_TARGET_INVALID', 400)
      const deadline = budgetClock() + timeoutMs, row = await pages('/user/installations', 'installations', token, deadline, item => String(item?.id) === id)
      if (!row || !installation(row).writable) throw githubError('GITHUB_ACCESS_DENIED', 403)
      const owner = githubId(row.account.id)
      return (await pages(`/user/installations/${id}/repositories`, 'repositories', token, deadline)).map(repository).filter(repo => repo.ownerId === owner && repo.writable)
    },
    authorize: (token, target) => authorize(token, target, budgetClock() + timeoutMs),
    async writeRevision(token, target, { id, revision, yaml }) {
      if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !Number.isInteger(revision) || revision < 1 || revision > 2147483647 || typeof yaml !== 'string' || Buffer.byteLength(yaml) > 2_000_000) throw githubError('GITHUB_TARGET_INVALID', 400)
      const deadline = budgetClock() + timeoutMs, allowed = await authorize(token, target, deadline)
      if (!allowed.private && allowed.allowPublic !== true) throw githubError('GITHUB_REPOSITORY_PUBLIC', 409)
      const path = `projects/${id}/revision-${revision}.yaml`, url = `https://api.github.com/repos/${allowed.repository}/contents/${path}`
      const existing = await call(url + '?ref=' + encodeURIComponent(allowed.branch), { token, deadline })
      if (existing.status !== 404) {
        const sha = crypto.createHash('sha1').update('blob ' + Buffer.byteLength(yaml) + '\0').update(yaml).digest('hex')
        if (existing.value?.type !== 'file' || typeof existing.value.sha !== 'string' || !/^[a-f0-9]{40}$/.test(existing.value.sha)) throw githubError('GITHUB_RESPONSE_INVALID')
        if (existing.value.sha !== sha) throw githubError('GITHUB_REVISION_CONFLICT', 409)
        return { commitSha: null, unchanged: true }
      }
      const result = await call(url, { token, method: 'PUT', deadline, body: { message: `project ${id} revision ${revision}`, content: Buffer.from(yaml).toString('base64'), branch: allowed.branch } })
      if (typeof result.value?.commit?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(result.value.commit.sha)) throw githubError('GITHUB_RESPONSE_INVALID')
      return { commitSha: result.value.commit.sha, unchanged: false }
    },
  }
}
