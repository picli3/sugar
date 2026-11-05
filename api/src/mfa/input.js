import { error } from '../shared/http.js'

export function mfaObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) error(400, 'mfaInputInvalid')
  return value
}
export function currentPassword(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024) error(400, 'mfaInputInvalid')
  return value
}
export function mfaCode(input) {
  if (typeof input.code !== 'string' || !input.code || input.code.length > 64 || (input.recovery !== undefined && typeof input.recovery !== 'boolean')) error(400, 'mfaInputInvalid')
  return { code: input.code.trim(), recovery: input.recovery === true }
}
export function loginProof(input) {
  mfaObject(input, ['challenge','code','recovery'])
  if (typeof input.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) error(401, 'mfaInvalid')
  return { challenge: input.challenge, ...mfaCode(input) }
}
