// Board badges (#32 notes, #33 outdated library version). Pure helpers so they are testable.
type BlockLike = { properties?: Record<string, unknown> | null } | null | undefined
const previewLength = 140

export function noteText(block: BlockLike): string {
  const notes = block?.properties?.notes
  return typeof notes === 'string' ? notes.trim() : ''
}
export const hasNotes = (block: BlockLike) => noteText(block) !== ''
// Collapses whitespace and shortens long notes for a tooltip; the full note stays in Properties.
export function notePreview(block: BlockLike): string {
  const text = noteText(block).replace(/\s+/g, ' ')
  return [...text].length > previewLength ? [...text].slice(0, previewLength - 1).join('') + '…' : text
}
// Outdated only when the library reports a strictly newer version for that exact block.
export function outdatedVersion(libraryId: unknown, libraryVersion: unknown, latest: Record<string, number>): number | null {
  if (typeof libraryId !== 'string' || !Number.isInteger(libraryVersion)) return null
  const current = latest[libraryId]
  return Number.isInteger(current) && current > (libraryVersion as number) ? current : null
}
export const uniqueLibraryIds = (nodes: { libraryId?: unknown }[]) => [...new Set(nodes.map(node => node.libraryId).filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)))].slice(0, 500)
