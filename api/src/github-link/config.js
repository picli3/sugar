import { publicOrigin } from '../security/headers.js'
import { configError } from '../config/secrets.js'
import { createGithubBox } from './secrets.js'
import { githubCallbackUri } from './protocol.js'
export function githubLinkConfig(env = process.env) {
  if (![undefined,'','false','true'].includes(env.GITHUB_CONNECT_ENABLED)) throw configError('GITHUB_CONNECT_ENABLED')
  const clientId = env.GITHUB_CLIENT_ID || '', clientSecret = env.GITHUB_CLIENT_SECRET || '', origin = publicOrigin(env.PUBLIC_ORIGIN), box = createGithubBox(env.GITHUB_USER_ENCRYPTION_KEY)
  if (clientId && !/^[A-Za-z0-9_.-]{1,200}$/.test(clientId)) throw configError('GITHUB_CLIENT_ID')
  if (clientSecret && !/^[\x21-\x7e]{1,256}$/.test(clientSecret)) throw configError('GITHUB_CLIENT_SECRET')
  const slug = env.GITHUB_APP_SLUG || ''
  if (slug && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) throw configError('GITHUB_APP_SLUG')
  let validOrigin = false
  if (origin) { try { githubCallbackUri(origin); validOrigin = true } catch { /* do not advertise insecure callbacks */ } }
  return { installationUrl: slug ? 'https://github.com/apps/' + slug + '/installations/new' : null, clientId, clientSecret, origin, box, available: !!(clientId && clientSecret && validOrigin && box.available), connectEnabled: env.GITHUB_CONNECT_ENABLED === 'true' }
}
