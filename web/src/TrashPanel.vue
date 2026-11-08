<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ArrowPathIcon, CubeIcon, PhotoIcon, RectangleGroupIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { sessionRequest } from './sessionRequest'
import { messages } from './i18n'

type Kind = 'project' | 'block' | 'image'
type Item = { kind: Kind; id: string; name: string; scope: string | null; owner: string | null; deleted_at: string; purgeable: boolean; purge_after: string; retentionDays: number }
const props = defineProps<{ language: 'es' | 'en'; admin: boolean }>()
const emit = defineEmits<{ changed: [kind: Kind] }>()
const items = ref<Item[]>([]), cursor = ref<string | null>(null), busy = ref(false), error = ref(''), notice = ref('')
const confirming = ref<string | null>(null), confirmText = ref('')
const t = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), (messages[props.language] as Record<string, string>)[key] || key)
const icons = { project: RectangleGroupIcon, block: CubeIcon, image: PhotoIcon }
const date = (value: string) => new Date(value).toLocaleString(props.language, { dateStyle: 'medium', timeStyle: 'short' })
let generation = 0

async function call(path: string, method = 'GET', body?: unknown) {
  const response = await sessionRequest(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw Error(result.error || t('trashFailed'))
  return result
}
async function load(more = false) {
  const current = ++generation
  busy.value = true; error.value = ''
  if (!more) notice.value = ''
  try {
    const page = await call('/api/trash' + (more && cursor.value ? '?cursor=' + encodeURIComponent(cursor.value) : ''))
    if (current !== generation) return
    items.value = more ? [...items.value, ...page.items] : page.items
    cursor.value = page.nextCursor
  } catch (e) { if (current === generation) error.value = e instanceof Error ? e.message : t('trashFailed') }
  finally { if (current === generation) busy.value = false }
}
async function act(item: Item, action: 'restore' | 'purge') {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    if (action === 'restore') await call(`/api/trash/${item.kind}/${item.id}/restore`, 'POST')
    else await call(`/api/trash/${item.kind}/${item.id}`, 'DELETE', { confirm: confirmText.value })
    items.value = items.value.filter(entry => entry.id !== item.id)
    confirming.value = null; confirmText.value = ''
    notice.value = t(action === 'restore' ? 'trashRestored' : 'trashPurged', { name: item.name })
    emit('changed', item.kind)
  } catch (e) { error.value = e instanceof Error ? e.message : t('trashFailed') }
  finally { busy.value = false }
}
function startPurge(item: Item) { confirming.value = item.id; confirmText.value = '' }
onMounted(() => load())
onUnmounted(() => { generation++ })
</script>

<template>
  <div class="trash-page">
    <p class="hint">{{ t('trashHint', { days: 30 }) }}</p>
    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message" role="status">{{ notice }}</p>
    <div v-if="!items.length && !busy && !error" class="empty-state"><TrashIcon class="ui-icon icon-empty" aria-hidden="true" /><h2>{{ t('trashEmpty') }}</h2></div>
    <ul class="trash-list">
      <li v-for="item in items" :key="item.kind + item.id" class="content-card trash-item">
        <div class="trash-item-head">
          <component :is="icons[item.kind]" class="ui-icon" aria-hidden="true" />
          <div class="trash-item-text">
            <strong :title="item.name">{{ item.name }}</strong>
            <small>{{ t('trashKind_' + item.kind) }}<template v-if="item.scope === 'catalog'"> · {{ t('libraryCatalog') }}</template><template v-if="admin && item.owner"> · {{ item.owner }}</template></small>
            <small>{{ t('trashDeletedAt', { date: date(item.deleted_at) }) }}</small>
            <small>{{ item.purgeable ? t('trashPurgeable') : t('trashPurgeAfter', { date: date(item.purge_after) }) }}</small>
          </div>
        </div>
        <div class="trash-actions">
          <button class="secondary" :disabled="busy" @click="act(item, 'restore')">{{ t('trashRestore') }}</button>
          <button v-if="item.purgeable && confirming !== item.id" class="text-danger" :disabled="busy" @click="startPurge(item)">{{ t('trashPurge') }}</button>
        </div>
        <form v-if="confirming === item.id" class="trash-confirm" @submit.prevent="act(item, 'purge')">
          <label>{{ t('trashPurgeConfirm', { name: item.name }) }}<input v-model="confirmText" autocomplete="off" spellcheck="false"></label>
          <div class="trash-actions"><button class="danger" type="submit" :disabled="busy || confirmText !== item.name">{{ t('trashPurge') }}</button><button class="secondary" type="button" @click="confirming = null">{{ t('cancel') }}</button></div>
        </form>
      </li>
    </ul>
    <div class="pagination-controls">
      <p class="hint" role="status">{{ t('trashLoaded', { count: items.length }) }}</p>
      <button v-if="cursor" class="secondary" :disabled="busy" @click="load(true)">{{ t('trashLoadMore') }}</button>
      <button class="secondary" type="button" :disabled="busy" @click="load()"><ArrowPathIcon class="ui-icon" aria-hidden="true" /> {{ t('trashReload') }}</button>
    </div>
  </div>
</template>

<style scoped>
.trash-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.trash-item { display: grid; gap: 12px; margin: 0; }
.trash-item-head { display: flex; gap: 12px; align-items: flex-start; min-width: 0; }
.trash-item-text { display: grid; gap: 2px; min-width: 0; }
.trash-item-text strong { overflow-wrap: anywhere; }
.trash-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.trash-confirm { display: grid; gap: 8px; }
.trash-confirm label { display: grid; gap: 6px; overflow-wrap: anywhere; }
</style>
