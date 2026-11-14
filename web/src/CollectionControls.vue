<script setup lang="ts">
import { reactive, watch } from 'vue'
import { Squares2X2Icon, ListBulletIcon } from '@heroicons/vue/24/outline'
import { messages } from './i18n'
import { emptyCollectionFilters, type CollectionFilters } from './collectionView'
const props = defineProps<{ language: 'es' | 'en'; mode: 'grid' | 'list'; filters: CollectionFilters; busy: boolean }>()
const emit = defineEmits<{ mode: [value: 'grid' | 'list']; apply: [value: CollectionFilters] }>()
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
const draft = reactive({ ...props.filters })
watch(() => props.filters, value => Object.assign(draft, value))
function clear() { Object.assign(draft, emptyCollectionFilters()); emit('apply', { ...draft }) }
</script>

<template>
  <div class="collection-controls">
    <div class="collection-view-buttons" role="group" :aria-label="t('collectionView')">
      <button type="button" class="secondary" :aria-pressed="mode === 'grid'" @click="emit('mode', 'grid')"><Squares2X2Icon class="ui-icon" aria-hidden="true" />{{ t('gridView') }}</button>
      <button type="button" class="secondary" :aria-pressed="mode === 'list'" @click="emit('mode', 'list')"><ListBulletIcon class="ui-icon" aria-hidden="true" />{{ t('listView') }}</button>
    </div>
    <form v-if="mode === 'list'" class="collection-filter-form" @submit.prevent="emit('apply', { ...draft })">
      <label>{{ t('name') }}<input v-model="draft.name" type="search" maxlength="200"></label>
      <label>{{ t('sortBy') }}<select v-model="draft.sort" :aria-label="t('sortBy')">
        <option value="default">{{ t('defaultOrder') }}</option>
        <option value="name">{{ t('name') }}</option><option value="created">{{ t('createdAt') }}</option>
        <option value="modified">{{ t('modifiedAt') }}</option><option value="size">{{ t('size') }}</option>
      </select></label>
      <label>{{ t('sortDirection') }}<select v-model="draft.direction" :aria-label="t('sortDirection')"><option value="asc">{{ t('ascending') }}</option><option value="desc">{{ t('descending') }}</option></select></label>
      <details class="collection-ranges"><summary>{{ t('dateAndSizeFilters') }}</summary><div class="collection-range-fields">
        <label>{{ t('createdFrom') }}<input v-model="draft.createdFrom" type="date" :max="draft.createdTo || undefined"></label>
        <label>{{ t('createdTo') }}<input v-model="draft.createdTo" type="date" :min="draft.createdFrom || undefined"></label>
        <label>{{ t('modifiedFrom') }}<input v-model="draft.modifiedFrom" type="date" :max="draft.modifiedTo || undefined"></label>
        <label>{{ t('modifiedTo') }}<input v-model="draft.modifiedTo" type="date" :min="draft.modifiedFrom || undefined"></label>
        <label>{{ t('minBytes') }}<input v-model="draft.minBytes" type="number" min="0" :max="draft.maxBytes || 2147483647" step="1"></label>
        <label>{{ t('maxBytes') }}<input v-model="draft.maxBytes" type="number" :min="draft.minBytes || 0" max="2147483647" step="1"></label>
      </div><p class="hint">{{ t('collectionDateHint') }}</p></details>
      <div class="header-actions"><button type="submit" class="primary" :disabled="busy">{{ t('applyFilters') }}</button><button type="button" class="secondary" :disabled="busy" @click="clear">{{ t('clearFilters') }}</button></div>
    </form>
  </div>
</template>
