import { sessionRequest } from './sessionRequest.ts'
export type MfaChallenge = { mfaRequired: true; challenge: string; expiresAt: string }
export type MfaStatus = { enabled: boolean; recoveryCodesRemaining: number; keyAvailable: boolean; canEnroll: boolean }
export type MfaSetup = { enrollmentId: string; secret: string; uri: string; expiresAt: string }
export async function mfaRequest(path: string, body: unknown | undefined, t: (key: string) => string, publicRequest = false) {
  const response = await (publicRequest ? fetch : sessionRequest)('/api' + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const key = typeof value.error === 'string' && /^mfa[A-Z]\w+$/.test(value.error) ? value.error : 'mfaFailed'
    throw Error(response.status === 429 && key !== 'mfaRateLimited' ? t('rateLimitWait').replace('{seconds}', response.headers.get('Retry-After') || '60') : t(key))
  }
  return value
}
