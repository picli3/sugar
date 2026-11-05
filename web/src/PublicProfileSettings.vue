<script setup lang="ts">
import { ref, watch } from 'vue'
import { sessionRequest } from './sessionRequest'
import { messages } from './i18n'

const props = defineProps<{ language: 'es' | 'en'; displayName: string | null | undefined }>()
const emit = defineEmits<{ saved: [displayName: string | null] }>()
const value = ref(props.displayName || ''), busy = ref(false), error = ref(''), saved = ref(false)
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
watch(() => props.displayName, name => { value.value = name || '' })

async function save() {
  if (busy.value) return
  busy.value = true; error.value = ''; saved.value = false
  try {
    const response = await sessionRequest('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: value.value }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw Error(result.error || t('publicNameFailed'))
    value.value = result.display_name || ''
    saved.value = true
    emit('saved', result.display_name ?? null)
  } catch (e) { error.value = e instanceof Error ? e.message : t('publicNameFailed') }
  finally { busy.value = false }
}
</script>

<template>
  <section class="content-card">
    <h2>{{ t('publicProfile') }}</h2>
    <p class="hint">{{ t('publicProfileHint') }}</p>
    <form @submit.prevent="save">
      <label>{{ t('publicName') }}<input v-model="value" maxlength="60" autocomplete="nickname" :placeholder="t('sugarUser')" :disabled="busy"></label>
      <p v-if="error" class="message error" role="alert">{{ error }}</p>
      <p v-if="saved" role="status">{{ t('publicNameSaved') }}</p>
      <button class="secondary" type="submit" :disabled="busy || value.trim() === (displayName || '')">{{ t('saveSettings') }}</button>
    </form>
  </section>
</template>
