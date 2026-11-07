export const schematicMaxBytes = 1_000_000
const schematicPath = /^\/api\/schematics\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/content$/

export function schematicDownloadUrl(value: unknown, shareToken?: string | null) {
  if (typeof value !== 'string' || !schematicPath.test(value)) return ''
  if (!shareToken || !/^[A-Za-z0-9_-]{43}$/.test(shareToken)) return value
  return `/api/shared/${shareToken}${value.slice('/api'.length)}`
}
