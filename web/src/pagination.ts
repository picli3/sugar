import { ref, shallowRef } from 'vue'
type Page<T> = { items: T[]; nextCursor: string | null }

export function usePagedList<T>(request: (path: string) => Promise<Page<T>>, endpoint: string | (() => string), key: (item: T) => string) {
  const items = shallowRef<T[]>([]), cursor = ref<string | null>(null), loading = ref(false)
  let generation = 0
  function reset() { generation++; items.value = []; cursor.value = null; loading.value = false }
  async function load(first: boolean, retain = false) {
    if (first) {
      if (retain) generation++
      else reset()
    }
    else if (loading.value || !cursor.value) return
    const current = generation, after = first ? null : cursor.value
    loading.value = true
    try {
      const path = typeof endpoint === 'function' ? endpoint() : endpoint
      const result = await request(path + '?limit=30' + (after ? '&cursor=' + encodeURIComponent(after) : ''))
      if (current !== generation) return
      const merged = new Map((first ? [] : items.value).map(item => [key(item), item]))
      for (const item of result.items) merged.set(key(item), item)
      items.value = [...merged.values()]; cursor.value = result.nextCursor
    } catch (e) { if (current === generation) throw e }
    finally { if (current === generation) loading.value = false }
  }
  return { items, cursor, loading, reset, first: () => load(true), refresh: () => load(true, true), more: () => load(false) }
}
