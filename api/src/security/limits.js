import crypto from 'node:crypto'
import { isIP } from 'node:net'
import { error } from '../shared/http.js'
import { registrationEmail } from '../registration/service.js'

export function clientNetwork(address = '') {
  const ip = address.toLowerCase().split('%')[0]
  if (isIP(ip) === 4) return ip
  if (isIP(ip) !== 6) return 'unknown'
  const [left, right] = ip.split('::'), a = left ? left.split(':') : [], b = right ? right.split(':') : []
  const expand = parts => parts.flatMap(part => part.includes('.') ? [part.split('.').slice(0, 2).reduce((n, v) => n * 256 + Number(v), 0).toString(16), part.split('.').slice(2).reduce((n, v) => n * 256 + Number(v), 0).toString(16)] : [part])
  const first = expand(a), last = expand(b), parts = (right === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last]).map(v => parseInt(v, 16))
  if (parts.slice(0, 5).every(v => v === 0) && parts[5] === 65535) return [parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255].join('.')
  return 'v6:' + parts.slice(0, 4).map(v => v.toString(16)).join(':') // one IPv6 /64
}
export function loginInput(input) {
  if (!input || Array.isArray(input) || typeof input.email !== 'string' || typeof input.password !== 'string') error(400, 'Email y contraseña inválidos')
  const email = input.email.trim().toLowerCase(), password = input.password
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email) || !password || Buffer.byteLength(password) > 1024) error(400, 'Email y contraseña inválidos')
  return { email, password }
}
export function proxyList(value = '') {
  if (!value) return false
  if (typeof value !== 'string') throw Error('TRUSTED_PROXIES debe ser una lista explícita de IP/CIDR')
  const entries = value.split(',').map(s => s.trim())
  for (const entry of entries) {
    const [ip, prefix, extra] = entry.split('/')
    if (!isIP(ip) || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) <= 0 || Number(prefix) > (isIP(ip) === 4 ? 32 : 128)))) throw Error('TRUSTED_PROXIES debe ser una lista explícita de IP/CIDR, sin rutas universales')
  }
  return entries
}
export function limitsConfig(env = process.env) {
  const number = (name, fallback, max = 100000) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`Configuración inválida: ${name}`)
    return value
  }
  return { ip: number('API_IP_LIMIT', 600), global: number('API_GLOBAL_LIMIT', 3000), loginIp: number('AUTH_IP_LIMIT', 20), loginGlobal: number('AUTH_GLOBAL_LIMIT', 120), account: number('AUTH_ACCOUNT_LIMIT', 10), credentials: number('AUTH_CREDENTIAL_LIMIT', 5), parallel: number('AUTH_HASH_CONCURRENCY', 4, 32), keys: number('AUTH_MAX_KEYS', 20000, 100000) }
}
export function createAccessControls({ secret, config = limitsConfig(), clock = Date.now } = {}) {
  const entries = new Map(), minute = 60000, accountWindow = 15 * minute
  let hashActive = 0, lastPrune = 0
  const digest = value => crypto.createHmac('sha256', secret).update(value).digest('hex')
  function limited(seconds) { throw Object.assign(new Error('Demasiadas solicitudes. Espera e inténtalo de nuevo.'), { status: 429, code: 'RATE_LIMITED', retryAfter: Math.max(1, Math.ceil(seconds)) }) }
  function bucket(key, duration) {
    const now = clock()
    if (now - lastPrune >= minute) { for (const [key, item] of entries) if (item.expires <= now) entries.delete(key); lastPrune = now }
    let item = entries.get(key)
    if (!item || item.expires <= now) {
      if (!item && entries.size >= config.keys) limited(60)
      item = { count: 0, failures: 0, blockedUntil: 0, expires: now + duration }; entries.set(key, item)
    }
    return item
  }
  function spend(key, limit, duration) {
    const item = bucket(key, duration)
    if (item.count >= limit) limited((item.expires - clock()) / 1000)
    item.count++; return item
  }
  const middleware = fn => (req, res, next) => { try { fn(req, res); next() } catch (e) { next(e) } }
  return {
    api: middleware(req => {
      if (req.path === '/health' && req.method === 'GET') return
      spend('api:global', config.global, minute)
      spend('api:' + digest(clientNetwork(req.ip)), config.ip, minute)
    }),
    login: middleware((req, res) => {
      spend('login:global', config.loginGlobal, minute)
      spend('login:ip:' + digest(clientNetwork(req.ip)), config.loginIp, minute)
      const input = loginInput(req.body), key = 'login:account:' + digest(input.email), item = bucket(key, accountWindow)
      if (item.blockedUntil > clock()) limited((item.blockedUntil - clock()) / 1000)
      spend(key, config.account, accountWindow)
      res.once('finish', () => {
        if (res.statusCode === 200) { entries.delete(key); return }
        if (res.statusCode === 401) { item.failures++; if (item.failures >= 3) item.blockedUntil = Math.min(item.expires, clock() + Math.min(60000, 1000 * 2 ** Math.min(6, item.failures - 3))) }
      })
    }),
    mfa: middleware(req => {
      spend('mfa:global', config.loginGlobal, minute)
      spend('mfa:ip:' + digest(clientNetwork(req.ip)), config.loginIp, minute)
      if (typeof req.body?.challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(req.body.challenge)) spend('mfa:challenge:' + digest(req.body.challenge), 10, accountWindow)
    }),
    github: middleware(req => { spend('github:global', 120, minute); spend('github:' + digest(req.user.id), 30, accountWindow) }),
    credentials: middleware(req => { spend('credentials:' + digest(req.user.id), config.credentials, accountWindow) }),
    registration: middleware(req => {
      const verify = req.path.toLowerCase().replace(/\/$/, '').endsWith('/verify')
      spend('account-mail:global', 30, minute)
      spend('registration:' + (verify ? 'verify:' : 'request:') + digest(clientNetwork(req.ip)), verify ? 20 : 3, accountWindow)
      if (!verify) spend('registration:email:' + digest(registrationEmail(req.body).email), 3, 60 * minute)
    }),
    recovery: middleware(req => {
      spend('account-mail:global', 30, minute)
      const request = req.path.toLowerCase().replace(/\/$/, '').endsWith('/request')
      spend('recovery:' + (request ? 'request:' : 'verify:') + digest(clientNetwork(req.ip)), request ? 3 : 20, accountWindow)
      if (request) spend('recovery:email:' + digest(registrationEmail(req.body).email), 3, 60 * minute)
      else if (typeof req.body?.token === 'string' && /^[a-f0-9]{64}$/.test(req.body.token)) spend('recovery:token:' + digest(req.body.token), 10, accountWindow)
    }),
    emailChange: middleware(req => {
      spend('account-mail:global', 30, minute)
      spend('email-change:' + digest(registrationEmail({ email: req.body?.email }).email), 3, 60 * minute)
    }),
    async runCredential(task) {
      if (hashActive >= config.parallel) limited(1)
      hashActive++
      // Release only when work ends: a disconnected client cannot free a bcrypt slot.
      try { return await task() } finally { hashActive-- }
    },
  }
}
