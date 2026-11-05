<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { sessionRequest } from './sessionRequest'
import { messages } from './i18n'

const props = defineProps<{ language: 'es' | 'en' }>()
const fields = ['platformBytes','aiBytes','userAiBytes','syncBytes','projectSyncBytes','categoryBytes','configBytes'] as const
type Field = typeof fields[number]
type Config = Record<Field, number> & { version: number; usage: Record<string, string> }
const config = ref<Config | null>(null), busy = ref(false), error = ref(''), saved = ref(false)
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
let generation = 0
async function load(method = 'GET', body?: unknown) {
  const current = ++generation
  busy.value = true; error.value = ''; saved.value = false
  try {
    const response = await sessionRequest('/api/total-storage', { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    const result = await response.json()
    if (!response.ok) throw Error(result.error || t('totalStorageFailed'))
    if (current === generation) { config.value = result; saved.value = method === 'PUT' }
  } catch (e) { if (current === generation) error.value = e instanceof Error ? e.message : t('totalStorageFailed') }
  finally { if (current === generation) busy.value = false }
}
async function save() {
  if (!config.value || busy.value) return
  await load('PUT', { ...Object.fromEntries(fields.map(key => [key, config.value![key]])), expectedVersion: config.value.version })
}
onMounted(() => load())
onUnmounted(() => { generation++ })
</script>

<template>
  <section class="content-card">
    <h2>{{ t('totalStorageTitle') }}</h2><p class="hint">{{ t('totalStorageHint') }}</p>
    <p v-if="error" class="message error" role="alert">{{ error }}</p><p v-if="saved" role="status">{{ t('totalStorageSaved') }}</p>
    <template v-if="config">
      <p v-for="key in ['total','images','documents','ai','sync','categories','config']" :key="key">{{ t('totalStorageUsage_' + key) }}: {{ config.usage[key] }} {{ t('bytes') }}</p>
      <form @submit.prevent="save"><fieldset :disabled="busy"><label v-for="key in fields" :key="key">{{ t('totalStorage_' + key) }}<input v-model.number="config[key]" type="number" min="0" max="10000000000000" step="1" required></label><button class="primary" type="submit">{{ t('saveSettings') }}</button></fieldset></form>
    </template>
    <button class="secondary" type="button" :disabled="busy" @click="load()">{{ t('imageStorageReload') }}</button>
  </section>
</template>
