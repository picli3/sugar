<script setup lang="ts">
import { computed } from 'vue'
import { messages } from './i18n'
import type { Draft } from './drafts'

// Recovery and conflict decisions are always explicit (#27): nothing is merged or overwritten silently.
const props = defineProps<{ language: 'es' | 'en'; draft: Draft | null; revision: number; conflict: { revision: number } | null; busy: boolean }>()
const emit = defineEmits<{ recover: []; discard: []; keepMine: []; loadServer: []; downloadMine: [] }>()
const t = (key: string, values: Record<string, string | number> = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), (messages[props.language] as Record<string, string>)[key] || key)
const when = computed(() => props.draft ? new Date(props.draft.savedAt).toLocaleString(props.language, { dateStyle: 'medium', timeStyle: 'short' }) : '')
</script>

<template>
  <div v-if="conflict" class="draft-notice conflict" role="alert">
    <strong>{{ t('conflictTitle') }}</strong>
    <p>{{ t('conflictBody', { revision: conflict.revision }) }}</p>
    <div class="draft-actions">
      <button class="primary" type="button" :disabled="busy" @click="emit('keepMine')">{{ t('conflictKeepMine') }}</button>
      <button class="secondary" type="button" :disabled="busy" @click="emit('downloadMine')">{{ t('conflictDownload') }}</button>
      <button class="text-danger" type="button" :disabled="busy" @click="emit('loadServer')">{{ t('conflictLoadServer') }}</button>
    </div>
  </div>
  <div v-else-if="draft" class="draft-notice" role="region" :aria-label="t('draftTitle')" aria-live="polite">
    <strong>{{ t('draftTitle') }}</strong>
    <p>{{ t('draftBody', { date: when }) }}</p>
    <p v-if="draft.baseRevision !== revision" class="hint">{{ t('draftOutdated', { base: draft.baseRevision, revision }) }}</p>
    <div class="draft-actions">
      <button class="primary" type="button" :disabled="busy" @click="emit('recover')">{{ t('draftRecover') }}</button>
      <button class="secondary" type="button" :disabled="busy" @click="emit('discard')">{{ t('draftDiscard') }}</button>
    </div>
  </div>
</template>

<style scoped>
.draft-notice { position: fixed; z-index: 60; top: 84px; left: 50%; transform: translateX(-50%); width: min(620px, calc(100vw - 32px)); background: var(--surface); color: var(--text); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 12px; padding: 14px 16px; box-shadow: 0 12px 30px rgb(0 0 0 / 18%); display: grid; gap: 6px; }
.draft-notice.conflict { border-left-color: var(--danger); }
.draft-notice p { margin: 0; }
.draft-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
</style>
