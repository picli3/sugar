<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { sessionRequest } from './sessionRequest'
import { messages } from './i18n'
const props = defineProps<{ language: 'es' | 'en'; admin: boolean }>()
const fields = ['userProjects','platformProjects','userBlocks','platformBlocks','projectRevisions','blockVersions','userRevisions','platformRevisions','userBytes','platformBytes'] as const
type Field = typeof fields[number]
type Config = Partial<Record<Field, number>> & { version?: number; usage: Record<string, string>; limits?: Partial<Record<Field, number>> }
const config = ref<Config | null>(null), busy = ref(false), error = ref(''), saved = ref(false)
const counters = ['projects','blocks','revisions','bytes'] as const
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
const limits = computed(() => props.admin ? config.value : config.value?.limits)
const cap = (key: typeof counters[number]) => limits.value?.[((props.admin ? 'platform' : 'user') + key[0]!.toUpperCase() + key.slice(1)) as Field]
let generation = 0
async function load(method = 'GET', body?: unknown) {
  const current = ++generation
  busy.value = true; error.value = ''; saved.value = false
  try {
    const response = await sessionRequest(props.admin ? '/api/document-storage' : '/api/me/document-storage', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const result = await response.json()
    if (!response.ok) throw Error(result.error || t('documentStorageFailed'))
    if (current === generation) { config.value = result; saved.value = method === 'PUT' }
  } catch (e) { if (current === generation) error.value = e instanceof Error ? e.message : t('documentStorageFailed') }
  finally { if (current === generation) busy.value = false }
}
async function save() {
  if (!props.admin || !config.value || busy.value) return
  await load('PUT', { ...Object.fromEntries(fields.map(key => [key, config.value![key]])), expectedVersion: config.value.version })
}
onMounted(() => load())
onUnmounted(() => { generation++ })
</script>

<template>
  <section class="content-card document-storage-panel">
    <h2>{{ t(admin ? 'documentStorageTitle' : 'documentStorageUsage') }}</h2><p class="hint">{{ t('documentStorageHint') }}</p>
    <p v-if="admin" class="hint">{{ t('documentStorageAdminHint') }}</p>
    <p v-if="error" class="message error" role="alert">{{ error }}</p><p v-if="saved" role="status">{{ t('documentStorageSaved') }}</p>
    <template v-if="config"><p v-for="key in counters" :key="key">{{ t('documentStorageCount_' + key) }}: {{ config.usage[key] }} / {{ cap(key) }}</p><p v-if="config.usage.sync_jobs !== undefined">{{ t('documentStorageSyncJobs') }}: {{ config.usage.sync_jobs }}</p><p v-if="!admin" class="hint">{{ t('documentStoragePerItem').replace('{projectRevisions}', String(limits?.projectRevisions)).replace('{blockVersions}', String(limits?.blockVersions)) }}</p></template>
    <form v-if="admin && config" @submit.prevent="save"><fieldset :disabled="busy"><label v-for="key in fields" :key="key">{{ t('documentStorage_' + key) }}<input v-model.number="config[key]" type="number" min="0" step="1" required></label><button class="primary" type="submit">{{ t('saveSettings') }}</button></fieldset></form>
    <button class="secondary" type="button" :disabled="busy" @click="load()">{{ t('imageStorageReload') }}</button>
  </section>
</template>
