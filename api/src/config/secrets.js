import fs from 'node:fs'
const names = ['DATABASE_URL','ADMIN_PASSWORD','JWT_SECRET','AI_ENCRYPTION_KEY','GITHUB_PRIVATE_KEY','RUNTIME_DB_PASSWORD','SMTP_PASSWORD','MAIL_ENCRYPTION_KEY','MFA_ENCRYPTION_KEY','GITHUB_CLIENT_SECRET','GITHUB_USER_ENCRYPTION_KEY']
export function configError(name) { return Object.assign(new Error(`Invalid secret configuration: ${name}`), { code: 'SECRET_CONFIG' }) }
export function loadSecretFiles(env = process.env) {
  for (const name of names) {
    const path = env[name + '_FILE']
    if (!path) continue
    if (env[name]) throw configError(name)
    let fd
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || ![0, process.getuid()].includes(stat.uid) || ![0o400,0o600].includes(stat.mode & 0o777) || stat.size > 65536) throw configError(name)
      const value = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '')
      if (!value || value.includes('\0')) throw configError(name)
      env[name] = value
    } catch { throw configError(name) } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  if (env.JWT_SECRET && Buffer.byteLength(env.JWT_SECRET) < 32) throw configError('JWT_SECRET')
  if (env.AI_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(env.AI_ENCRYPTION_KEY)) throw configError('AI_ENCRYPTION_KEY')
  if (env.MFA_ENCRYPTION_KEY && (!/^[a-f0-9]{64}$/i.test(env.MFA_ENCRYPTION_KEY) || [env.AI_ENCRYPTION_KEY,env.MAIL_ENCRYPTION_KEY].some(value => value && value.toLowerCase() === env.MFA_ENCRYPTION_KEY.toLowerCase()))) throw configError('MFA_ENCRYPTION_KEY')
  if (env.MFA_ENROLLMENT_ENABLED && !['true','false'].includes(env.MFA_ENROLLMENT_ENABLED)) throw configError('MFA_ENROLLMENT_ENABLED')
  if (env.GITHUB_USER_ENCRYPTION_KEY && (!/^[a-f0-9]{64}$/i.test(env.GITHUB_USER_ENCRYPTION_KEY) || [env.AI_ENCRYPTION_KEY,env.MAIL_ENCRYPTION_KEY,env.MFA_ENCRYPTION_KEY].some(value => value && value.toLowerCase() === env.GITHUB_USER_ENCRYPTION_KEY.toLowerCase()))) throw configError('GITHUB_USER_ENCRYPTION_KEY')
  if (env.MAIL_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(env.MAIL_ENCRYPTION_KEY)) throw configError('MAIL_ENCRYPTION_KEY')
}
