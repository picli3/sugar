import { ref, shallowRef } from 'vue'
import type { CatalogBlockItem } from './types'

type CatalogPage = { items: CatalogBlockItem[]; nextCursor: string | null }

export function useBlockCatalog(
  request: (path: string, signal: AbortSignal) => Promise<CatalogPage>,
  resolveCategories: (items: CatalogBlockItem[]) => Promise<void>,
) {
  const items = shallowRef<CatalogBlockItem[]>([])
  const status = ref<'idle' | 'loading' | 'complete' | 'error'>('idle')
  const failure = ref('')
  let cursor: string | null = null
  let controller: AbortController | undefined

  function reset() {
    controller?.abort()
    controller = undefined
    cursor = null
    items.value = []
    status.value = 'idle'
    failure.value = ''
  }

  async function load() {
    if (status.value === 'loading' || status.value === 'complete') return
    const { signal } = controller = new AbortController()
    status.value = 'loading'
    failure.value = ''
    try {
      do {
        const path = '/blocks/catalog/page?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
        const result = await request(path, signal)
        if (signal.aborted) return
        // Keep the cursor until both the block page and its category context succeed.
        if (result.nextCursor && (!result.items.length || result.nextCursor === cursor)) throw Error()
        const merged = new Map(items.value.map(row => [row.id, row]))
        for (const row of result.items) merged.set(row.id, row)
        items.value = [...merged.values()]
        await resolveCategories(result.items)
        if (signal.aborted) return
        cursor = result.nextCursor
      } while (cursor)
      status.value = 'complete'
    } catch (error) {
      if (signal.aborted) return
      failure.value = error instanceof Error ? error.message : ''
      status.value = 'error'
    }
  }

  return { items, status, failure, load, reset, refresh: () => { reset(); return load() } }
}
