export type CollectionFilters = {
  sort: string; direction: string; name: string; createdFrom: string; createdTo: string
  modifiedFrom: string; modifiedTo: string; minBytes: string; maxBytes: string
}
export type CollectionSortField = 'name' | 'created' | 'modified' | 'size'

export function collectionOrder(filters: CollectionFilters) {
  return filters.sort === 'default' ? { sort: 'created', direction: 'desc' } : filters
}

export function sortCollection(filters: CollectionFilters, field: CollectionSortField): CollectionFilters {
  const current = collectionOrder(filters)
  const direction = current.sort === field
    ? current.direction === 'asc' ? 'desc' : 'asc'
    : field === 'name' ? 'asc' : 'desc'
  return { ...filters, sort: field, direction }
}

export const emptyCollectionFilters = (): CollectionFilters => ({
  sort: 'default', direction: 'desc', name: '', createdFrom: '', createdTo: '',
  modifiedFrom: '', modifiedTo: '', minBytes: '', maxBytes: '',
})

export function collectionPath(kind: 'projects' | 'images', filters: CollectionFilters) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''))
  return `/${kind}/browse?${query}`
}

export function collectionViewPreference(kind: string): 'grid' | 'list' {
  try { return localStorage.getItem('sugar:' + kind + ':view') === 'list' ? 'list' : 'grid' }
  catch { return 'grid' }
}

export function saveCollectionView(kind: string, value: string) {
  try { localStorage.setItem('sugar:' + kind + ':view', value) } catch { /* View remains usable without storage. */ }
}

export function formatBytes(bytes: number, language: string) {
  if (bytes < 1024) return new Intl.NumberFormat(language).format(bytes) + ' B'
  const unit = bytes < 1024 * 1024 ? 1024 : 1024 * 1024
  return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / unit) + (unit === 1024 ? ' KiB' : ' MiB')
}
