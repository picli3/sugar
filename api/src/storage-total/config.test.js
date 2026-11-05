import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTotalStorage, validateTotalStorage } from './config.js'

test('total storage configuration accepts zero and exact integer budgets only', () => {
  assert.deepEqual(validateTotalStorage(defaultTotalStorage), defaultTotalStorage)
  assert.equal(validateTotalStorage({ ...defaultTotalStorage, projectSyncBytes: 0 }).projectSyncBytes, 0)
  for (const change of [{ platformBytes: -1 }, { aiBytes: 1.5 }, { categoryBytes: '100' }, { configBytes: Infinity }, { userAiBytes: 10_000_000_000_001 }, { unknown: 1 }]) {
    assert.throws(() => validateTotalStorage({ ...defaultTotalStorage, ...change }), { status: 400 })
  }
})
