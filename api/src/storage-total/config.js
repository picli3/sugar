import { error } from '../shared/http.js'

export const defaultTotalStorage = Object.freeze({
  platformBytes: 3_000_000_000,
  aiBytes: 500_000_000,
  userAiBytes: 50_000_000,
  syncBytes: 500_000_000,
  projectSyncBytes: 250_000_000,
  categoryBytes: 10_000_000,
  configBytes: 10_000_000,
})

export function validateTotalStorage(input) {
  if (!input || Object.keys(input).some(key => ![...Object.keys(defaultTotalStorage), 'expectedVersion'].includes(key))) error(400, 'Cuota global inválida / Invalid global quota')
  return Object.fromEntries(Object.keys(defaultTotalStorage).map(key => {
    const value = input[key]
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000_000_000) error(400, 'Cuota global inválida / Invalid global quota')
    return [key, value]
  }))
}
