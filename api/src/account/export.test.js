import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccountExport } from './export.js'

test('one export per account and a global concurrency cap, released after use', () => {
  const exports = createAccountExport({ transaction: async () => {}, maxConcurrent: 2 })
  const a = exports.begin({ id: 'a' })
  assert.throws(() => exports.begin({ id: 'a' }), { status: 429 })
  const b = exports.begin({ id: 'b' })
  assert.throws(() => exports.begin({ id: 'c' }), err => err.status === 429 && err.retryAfter === 60)
  a(); exports.begin({ id: 'c' })(); b()
  assert.throws(() => exports.begin(null), { status: 401 })
})
