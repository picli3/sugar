import crypto from 'node:crypto'
import { githubError } from './protocol.js'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const context = ({ userId, linkId, purpose }) => {
  if (!uuid(userId) || !uuid(linkId) || !['access','refresh','verifier'].includes(purpose)) throw githubError('GITHUB_SECRET_INVALID', 503)
  return Buffer.from(`sugar:github:v1:${userId.toLowerCase()}:${linkId.toLowerCase()}:${purpose}`)
}
export function createGithubBox(hexKey) {
  const key = typeof hexKey === 'string' && /^[a-f0-9]{64}$/i.test(hexKey) ? Buffer.from(hexKey, 'hex') : null
  const configured = () => { if (!key) throw githubError('GITHUB_KEY_REQUIRED', 503); return key }
  return Object.freeze({
    available: key !== null,
    encrypt(scope, value) {
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024) throw githubError('GITHUB_SECRET_INVALID', 503)
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', configured(), iv)
      cipher.setAAD(context(scope))
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return { v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }
    },
    decrypt(scope, box) {
      const secretKey = configured()
      try {
        if (!box || Array.isArray(box) || Object.keys(box).sort().join(',') !== 'data,iv,tag,v' || box.v !== 1 || typeof box.iv !== 'string' || !/^[a-f0-9]{24}$/.test(box.iv) || typeof box.tag !== 'string' || !/^[a-f0-9]{32}$/.test(box.tag) || typeof box.data !== 'string' || !/^(?:[a-f0-9]{2}){1,1024}$/.test(box.data)) throw Error()
        const cipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(box.iv, 'hex'))
        cipher.setAAD(context(scope)); cipher.setAuthTag(Buffer.from(box.tag, 'hex'))
        return Buffer.concat([cipher.update(Buffer.from(box.data, 'hex')), cipher.final()]).toString('utf8')
      } catch { throw githubError('GITHUB_SECRET_INVALID', 503) }
    },
  })
}
