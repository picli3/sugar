// Unsaved project drafts (#27), kept only in this browser and scoped to user + project.
// Policy: written shortly after each change, kept for 7 days, removed on save, discard,
// sign-out and account closure; kept when a session expires so the work can be recovered.
export type Draft = { yaml: string; baseRevision: number; savedAt: number; raw: boolean }
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export const draftRetentionMs = 7 * 24 * 60 * 60 * 1000
export const maxDraftChars = 2_000_000
const prefix = 'sugar:draft:v1:'
const validId = (value: string) => /^[0-9a-f-]{1,64}$/i.test(value)
export const draftKey = (userId: string, projectId: string) => {
  if (!validId(userId) || !validId(projectId)) throw new Error('Invalid draft scope')
  return `${prefix}${userId}:${projectId}`
}
const keys = (storage: StorageLike) => Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key && key.startsWith(prefix))

export function saveDraft(storage: StorageLike, userId: string, projectId: string, draft: Draft): boolean {
  if (typeof draft.yaml !== 'string' || draft.yaml.length > maxDraftChars) return false
  try { storage.setItem(draftKey(userId, projectId), JSON.stringify(draft)); return true } catch { return false }
}
export function loadDraft(storage: StorageLike, userId: string, projectId: string, now = Date.now()): Draft | null {
  const key = draftKey(userId, projectId)
  let value: unknown
  try { value = JSON.parse(storage.getItem(key) || 'null') } catch { value = undefined }
  const draft = value as Draft | null
  const valid = !!draft && typeof draft.yaml === 'string' && Number.isInteger(draft.baseRevision) && Number.isFinite(draft.savedAt) && typeof draft.raw === 'boolean'
  if (!valid || now - draft!.savedAt > draftRetentionMs || draft!.savedAt > now + 60_000) { if (value !== null) safeRemove(storage, key); return null }
  return draft
}
const safeRemove = (storage: StorageLike, key: string) => { try { storage.removeItem(key) } catch { /* storage unavailable */ } }
export const removeDraft = (storage: StorageLike, userId: string, projectId: string) => safeRemove(storage, draftKey(userId, projectId))
export function clearUserDrafts(storage: StorageLike, userId: string) {
  for (const key of keys(storage)) if (key.startsWith(`${prefix}${userId}:`)) safeRemove(storage, key)
}
export function purgeExpiredDrafts(storage: StorageLike, now = Date.now()) {
  for (const key of keys(storage)) {
    try { const draft = JSON.parse(storage.getItem(key) || 'null'); if (!draft || !(now - draft.savedAt <= draftRetentionMs)) safeRemove(storage, key) } catch { safeRemove(storage, key) }
  }
}
