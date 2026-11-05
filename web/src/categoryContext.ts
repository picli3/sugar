import { computed, ref, shallowRef } from 'vue'
import { usePagedList } from './pagination.ts'
import type { Category } from './types'

export function useCategoryContext(request: (path: string, method?: string, body?: unknown) => Promise<any>) {
  const pages = usePagedList<Category>(path => request(path), '/categories/page', row => row.id)
  const context = shallowRef<Category[]>([]), resolving = ref(false)
  const items = computed(() => [...new Map([...context.value, ...pages.items.value].map(row => [row.id, row])).values()])
  const loading = computed(() => pages.loading.value || resolving.value)
  let generation = 0, active = 0
  function reset() { generation++; pages.reset(); context.value = []; active = 0; resolving.value = false }
  async function ensure(slugs: string[]) {
    const current = generation, known = new Map(items.value.map(row => [row.slug, row])), ids = new Set(items.value.map(row => row.id))
    const missing = [...new Set(slugs)].filter(slug => { const row = known.get(slug); return !row || (row.parent_id && !ids.has(row.parent_id)) })
    if (!missing.length) return
    active++; resolving.value = true
    try {
      for (let start = 0; start < missing.length; start += 64) {
        if (current !== generation) return
        const rows: Category[] = await request('/categories/resolve', 'POST', { slugs: missing.slice(start, start + 64) })
        if (current !== generation) return
        context.value = [...new Map([...context.value, ...rows].map(row => [row.id, row])).values()]
      }
    } catch (e) { if (current === generation) throw e }
    finally { if (current === generation) { active--; resolving.value = active > 0 } }
  }
  return { pages, items, loading, reset, ensure }
}
