import crypto from 'node:crypto'
import { error } from '../shared/http.js'
import { decodeSecret } from './totp.js'
import { accountIdentity } from './recovery.js'

// Dedicated key supplied by the future MFA bootstrap; never reuse AI/mail keys.
export function createSecretBox(hexKey) {
  const key = typeof hexKey === 'string' && /^[a-f0-9]{64}$/i.test(hexKey) ? Buffer.from(hexKey, 'hex') : null
  const configured = () => { if (!key) error(503, 'mfaKeyMissing'); return key }
  const context = id => Buffer.from('sugar:mfa:totp:v1:' + accountIdentity(id))
  return Object.freeze({
    available: key !== null,
    encrypt(userId, secret) {
      decodeSecret(secret)
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', configured(), iv)
      cipher.setAAD(context(userId))
      const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      return { v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }
    },
    decrypt(userId, envelope) {
      const secretKey = configured()
      try {
        if (!envelope || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'data,iv,tag,v' || envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string' || !/^[a-f0-9]{24}$/.test(envelope.iv) || !/^[a-f0-9]{32}$/.test(envelope.tag) || !/^[a-f0-9]{64}$/.test(envelope.data)) throw Error()
        const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(envelope.iv, 'hex'))
        decipher.setAAD(context(userId)); decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'))
        const secret = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()]).toString('utf8')
        decodeSecret(secret)
        return secret
      } catch { error(503, 'mfaSecretInvalid') }
    },
  })
}
