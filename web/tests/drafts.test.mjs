import test from 'node:test'
import assert from 'node:assert/strict'
import { clearUserDrafts, draftKey, draftRetentionMs, loadDraft, maxDraftChars, purgeExpiredDrafts, removeDraft, saveDraft } from '../src/drafts.ts'

const memory = () => { const map = new Map(); return { map, get length() { return map.size }, key: i => [...map.keys()][i] ?? null, getItem: k => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) } }
const a = 'aaaaaaaa-0000-0000-0000-000000000001', b = 'bbbbbbbb-0000-0000-0000-000000000002', p = 'cccccccc-0000-0000-0000-000000000003', q = 'dddddddd-0000-0000-0000-000000000004'
const draft = (yaml = 'name: x', savedAt = 1_000) => ({ yaml, baseRevision: 3, savedAt, raw: false })

test('drafts are scoped per user and project', () => {
  const s = memory()
  assert.equal(saveDraft(s, a, p, draft('mine')), true)
  assert.equal(saveDraft(s, b, p, draft('theirs')), true)
  assert.equal(loadDraft(s, a, p, 2_000).yaml, 'mine')
  assert.equal(loadDraft(s, b, p, 2_000).yaml, 'theirs')
  assert.equal(loadDraft(s, a, q, 2_000), null)
  assert.throws(() => draftKey('../x', p))
})
test('drafts expire after the retention window and malformed entries are discarded', () => {
  const s = memory()
  saveDraft(s, a, p, draft('old', 0))
  assert.equal(loadDraft(s, a, p, draftRetentionMs).yaml, 'old')
  assert.equal(loadDraft(s, a, p, draftRetentionMs + 1), null)
  assert.equal(s.length, 0)
  s.setItem(draftKey(a, p), '{broken'); assert.equal(loadDraft(s, a, p, 1), null); assert.equal(s.length, 0)
  s.setItem(draftKey(a, p), JSON.stringify({ yaml: 1 })); assert.equal(loadDraft(s, a, p, 1), null)
  saveDraft(s, a, p, draft('future', 10_000_000)); assert.equal(loadDraft(s, a, p, 0), null)
})
test('sign-out cleanup removes only that user’s drafts; purge removes expired ones', () => {
  const s = memory()
  saveDraft(s, a, p, draft()); saveDraft(s, a, q, draft()); saveDraft(s, b, p, draft())
  s.setItem('sidebarCollapsed', 'true')
  clearUserDrafts(s, a)
  assert.deepEqual([...s.map.keys()].sort(), [draftKey(b, p), 'sidebarCollapsed'].sort())
  saveDraft(s, a, p, draft('fresh', draftRetentionMs)); removeDraft(s, b, p)
  saveDraft(s, b, q, draft('stale', 0))
  purgeExpiredDrafts(s, draftRetentionMs + 10)
  assert.deepEqual([...s.map.keys()].sort(), [draftKey(a, p), 'sidebarCollapsed'].sort())
})
test('oversized drafts and storage failures fail closed without throwing', () => {
  const s = memory()
  assert.equal(saveDraft(s, a, p, draft('x'.repeat(maxDraftChars + 1))), false)
  const full = { ...memory(), setItem: () => { throw new Error('QuotaExceededError') } }
  assert.equal(saveDraft(full, a, p, draft()), false)
})
