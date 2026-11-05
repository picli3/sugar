import crypto from 'node:crypto'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const periodSeconds = 30

export function encodeSecret(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 20) throw TypeError('Invalid MFA secret')
  let value = 0, bits = 0, encoded = ''
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; encoded += alphabet[(value >>> bits) & 31] }
    value &= (1 << bits) - 1
  }
  return encoded
}
export const generateSecret = () => encodeSecret(crypto.randomBytes(20))
export function decodeSecret(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) throw TypeError('Invalid MFA secret')
  let value = 0, bits = 0
  const bytes = []
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character); bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255) }
    value &= (1 << bits) - 1
  }
  return Buffer.from(bytes)
}

// RFC 4226 dynamic truncation. Production validation below fixes SHA1/6 digits;
// optional algorithms/digits permit the independent RFC 6238 test vectors.
export function hotp(key, counter, { algorithm = 'sha1', digits = 6 } = {}) {
  if (!Buffer.isBuffer(key) || key.length < 20 || key.length > 64 || !['sha1','sha256','sha512'].includes(algorithm) || ![6,8].includes(digits)) throw TypeError('Invalid OTP parameters')
  if (typeof counter === 'number') {
    if (!Number.isSafeInteger(counter) || counter < 0) throw TypeError('Invalid OTP counter')
    counter = BigInt(counter)
  }
  if (typeof counter !== 'bigint' || counter < 0n || counter > 0xffffffffffffffffn) throw TypeError('Invalid OTP counter')
  const moving = Buffer.alloc(8); moving.writeBigUInt64BE(counter)
  const digest = crypto.createHmac(algorithm, key).update(moving).digest(), offset = digest.at(-1) & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0')
}

// Return the consumed step, never a boolean that might omit replay state.
// The caller must persist it atomically and enforce attempts/expiry in storage.
export function matchTotp(secret, code, { now = Date.now(), after = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(after) || after < -1) return null
  const key = decodeSecret(secret), step = Math.floor(now / (periodSeconds * 1000)), submitted = Buffer.from(code)
  let matched = null
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate < 0) continue
    const same = crypto.timingSafeEqual(Buffer.from(hotp(key, candidate)), submitted)
    if (same && candidate > after) matched = candidate
  }
  return matched
}

export function enrollmentUri(secret, account) {
  decodeSecret(secret)
  if (typeof account !== 'string' || !account || account.length > 254 || /[:\x00-\x1f\x7f]/.test(account)) throw TypeError('Invalid MFA account label')
  const uri = new URL('otpauth://totp/' + encodeURIComponent('Sugar:' + account))
  for (const [key, value] of Object.entries({ secret, issuer: 'Sugar', algorithm: 'SHA1', digits: '6', period: String(periodSeconds) })) uri.searchParams.set(key, value)
  return uri.toString()
}
