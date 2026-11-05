import crypto from 'node:crypto'

export function accountIdentity(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw TypeError('Invalid MFA account')
  return id.toLowerCase()
}
function normalized(code) {
  if (typeof code !== 'string' || code.length > 64) return null
  const value = code.trim().toUpperCase()
  return /^(?:[A-F0-9]{32}|(?:[A-F0-9]{4}-){7}[A-F0-9]{4})$/.test(value) ? value.replaceAll('-', '') : null
}
export function recoveryHash(userId, code) {
  const value = normalized(code)
  if (!value) return null
  return crypto.createHash('sha256').update('sugar:mfa:recovery:v1:' + accountIdentity(userId) + ':' + value).digest('hex')
}
export function generateRecoveryCodes(userId) {
  accountIdentity(userId)
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-'))
  if (new Set(codes).size !== codes.length) throw Error('MFA randomness failed')
  return { codes, hashes: codes.map(code => recoveryHash(userId, code)) }
}
export function matchesRecoveryCode(userId, code, hash) {
  const expected = recoveryHash(userId, code)
  return expected !== null && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))
}
