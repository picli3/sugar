<script setup lang="ts">
import { ref } from 'vue'
import { ArrowDownTrayIcon } from '@heroicons/vue/24/outline'
import { sessionRequest } from './sessionRequest'
import { messages } from './i18n'

const props = defineProps<{ language: 'es' | 'en'; email: string; admin: boolean }>()
const emit = defineEmits<{ closed: [] }>()
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
const password = ref(''), confirmEmail = ref(''), busy = ref(false), error = ref('')

async function closeAccount() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const response = await sessionRequest('/api/me/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: password.value, confirm: confirmEmail.value }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw Error(result.error || t('accountCloseFailed'))
    password.value = ''
    emit('closed')
  } catch (e) { error.value = e instanceof Error ? e.message : t('accountCloseFailed') }
  finally { busy.value = false }
}
</script>

<template>
  <section class="content-card">
    <h2>{{ t('accountData') }}</h2>
    <p class="hint">{{ t('accountExportHint') }}</p>
    <a class="secondary" href="/api/me/export" download><ArrowDownTrayIcon class="ui-icon" aria-hidden="true" /> {{ t('accountExport') }}</a>
    <details class="account-close">
      <summary>{{ t('accountClose') }}</summary>
      <p class="hint">{{ t('accountCloseHint') }}</p>
      <p v-if="admin" class="hint">{{ t('accountCloseAdminHint') }}</p>
      <form @submit.prevent="closeAccount">
        <label>{{ t('accountCloseConfirm') }}<input v-model="confirmEmail" type="email" autocomplete="off" :placeholder="email" :disabled="busy"></label>
        <label>{{ t('currentPassword') }}<input v-model="password" type="password" autocomplete="current-password" :disabled="busy"></label>
        <p v-if="error" class="message error" role="alert">{{ error }}</p>
        <button class="danger" type="submit" :disabled="busy || !password || confirmEmail.trim().toLowerCase() !== email.toLowerCase()">{{ t('accountCloseButton') }}</button>
      </form>
    </details>
  </section>
</template>

<style scoped>
a.secondary { display: inline-flex; text-decoration: none; }
.account-close { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
.account-close summary { cursor: pointer; font-weight: 700; color: var(--danger, #b42318); }
.account-close form { display: grid; gap: 12px; margin-top: 12px; }
</style>
