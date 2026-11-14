// Properties are untrusted project data; only absolute web links become clickable.
export function propertyUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}
