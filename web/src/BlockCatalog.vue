<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import YAML from 'yaml'
import { ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import CatalogBlock from './CatalogBlock.vue'
import CategorySymbol from './CategorySymbol.vue'
import type { CategoryIconMap } from './categoryIcons'
import { messages } from './i18n'
import type { Category, LibraryItem, Block } from './types'

const props = defineProps<{ items: LibraryItem[]; categories: Category[]; mode: 'palette' | 'library'; selectedId?: string | null; editable: boolean; language: 'es' | 'en' }>()
const emit = defineEmits<{ select: [id: string]; add: [item: LibraryItem]; dragstart: [event: DragEvent, item: LibraryItem] }>()
const iconMap = computed<CategoryIconMap>(() => Object.fromEntries(props.categories.map(c => [c.slug,c.icon])))
const search = ref('')
const searchCollapsed = ref<string[]>([])
watch(search, () => { searchCollapsed.value = [] })
const storageKey = `catalogExpanded:${props.mode}`
function saved(): string[] { try { return JSON.parse(localStorage.getItem(storageKey) || '[]') } catch { return [] } }
const expanded = ref<string[]>(saved())
watch(expanded, value => localStorage.setItem(storageKey, JSON.stringify(value)), { deep: true })
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
const normalize = (value: unknown) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const active = computed(() => props.categories.filter(c => !c.deleted_at))
const roots = computed(() => active.value.filter(c => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name)))
const children = (root: Category) => active.value.filter(c => c.parent_id === root.id).sort((a, b) => a.name.localeCompare(b.name))
const bySlug = computed(() => new Map(active.value.map(c => [c.slug, c])))
const entries = computed(() => props.items.map(item => {
  let block: Partial<Block> = {}
  try { block = YAML.parse(item.yaml) || {} } catch { /* Keep malformed legacy items visible. */ }
  const root = bySlug.value.get(block.category || '')
  const child = bySlug.value.get(block.subcategory || '')
  const category = root && !root.parent_id ? root : null
  const subcategory = category && child?.parent_id === category.id ? child : null
  const terms = [item.name, block.function, block.model, category?.name, subcategory?.name, ...((block.ports || []).flatMap(port => [port.id, port.label, port.protocol]))]
  return { item, category, subcategory, searchText: normalize(terms.join(' ')) }
}))
const matches = computed(() => entries.value.filter(entry => entry.searchText.includes(normalize(search.value.trim()))))
const categoryEntries = (category: Category) => matches.value.filter(entry => entry.category?.id === category.id)
const directEntries = (category: Category) => categoryEntries(category).filter(entry => !entry.subcategory)
const childEntries = (category: Category) => matches.value.filter(entry => entry.subcategory?.id === category.id)
const uncategorized = computed(() => matches.value.filter(entry => !entry.category))
const visibleRoots = computed(() => search.value.trim() ? roots.value.filter(root => categoryEntries(root).length) : roots.value)
const isOpen = (key: string) => search.value.trim() ? !searchCollapsed.value.includes(key) : expanded.value.includes(key)
function toggle(key: string) {
  if (search.value.trim()) searchCollapsed.value = searchCollapsed.value.includes(key) ? searchCollapsed.value.filter(item => item !== key) : [...searchCollapsed.value, key]
  else expanded.value = expanded.value.includes(key) ? expanded.value.filter(item => item !== key) : [...expanded.value, key]
}
</script>

<template>
  <div class="catalog">
    <div class="catalog-search"><MagnifyingGlassIcon class="ui-icon catalog-search-icon" aria-hidden="true" /><input v-model="search" type="search" :aria-label="t('searchBlocks')" :placeholder="t('searchBlocks')"><button v-if="search" :aria-label="t('clearSearch')" @click="search=''"><XMarkIcon class="ui-icon" aria-hidden="true" /></button></div>
    <p v-if="search" class="catalog-count">{{ matches.length }} {{ t('searchResults') }}</p>
    <section v-for="root in visibleRoots" :key="root.id" class="catalog-group">
      <button class="catalog-toggle" :aria-expanded="isOpen(root.slug)" :aria-controls="`${mode}-category-${root.slug}`" @click="toggle(root.slug)"><ChevronRightIcon class="ui-icon catalog-arrow" :class="{open:isOpen(root.slug)}" aria-hidden="true" /><CategorySymbol :icon="root.icon" /><strong>{{ root.name }}</strong><span class="catalog-badge">{{ categoryEntries(root).length }}</span></button>
      <div v-show="isOpen(root.slug)" :id="`${mode}-category-${root.slug}`" class="catalog-children">
        <CatalogBlock v-for="entry in directEntries(root)" :key="entry.item.id" :item="entry.item" :icons="iconMap" :mode="mode" :selected-id="selectedId" :editable="editable" :language="language" @select="emit('select', $event)" @add="emit('add', $event)" @dragstart="emit('dragstart', $event, entry.item)" />
        <section v-for="child in children(root).filter(c => !search.trim() || childEntries(c).length)" :key="child.id" class="catalog-subgroup">
          <button class="catalog-toggle catalog-toggle-child" :aria-expanded="isOpen(child.slug)" :aria-controls="`${mode}-subcategory-${child.slug}`" @click="toggle(child.slug)"><ChevronRightIcon class="ui-icon catalog-arrow" :class="{open:isOpen(child.slug)}" aria-hidden="true" /><CategorySymbol :icon="child.icon || root.icon" /><strong>{{ child.name }}</strong><span class="catalog-badge">{{ childEntries(child).length }}</span></button>
          <div v-show="isOpen(child.slug)" :id="`${mode}-subcategory-${child.slug}`" class="catalog-children catalog-leaves">
            <CatalogBlock v-for="entry in childEntries(child)" :key="entry.item.id" :item="entry.item" :icons="iconMap" :mode="mode" :selected-id="selectedId" :editable="editable" :language="language" @select="emit('select', $event)" @add="emit('add', $event)" @dragstart="emit('dragstart', $event, entry.item)" />
          </div>
        </section>
      </div>
    </section>
    <section v-if="uncategorized.length" class="catalog-group"><button class="catalog-toggle" :aria-expanded="isOpen('uncategorized')" :aria-controls="`${mode}-uncategorized`" @click="toggle('uncategorized')"><ChevronRightIcon class="ui-icon catalog-arrow" :class="{open:isOpen('uncategorized')}" aria-hidden="true" /><strong>{{ t('uncategorized') }}</strong><span class="catalog-badge">{{ uncategorized.length }}</span></button><div v-show="isOpen('uncategorized')" :id="`${mode}-uncategorized`" class="catalog-children"><CatalogBlock v-for="entry in uncategorized" :key="entry.item.id" :item="entry.item" :icons="iconMap" :mode="mode" :selected-id="selectedId" :editable="editable" :language="language" @select="emit('select', $event)" @add="emit('add', $event)" @dragstart="emit('dragstart', $event, entry.item)" /></div></section>
    <p v-if="search && !matches.length" class="hint catalog-empty">{{ t('noSearchResults') }}</p>
  </div>
</template>
