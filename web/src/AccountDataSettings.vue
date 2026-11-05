<script setup lang="ts">
import { ArrowDownTrayIcon } from '@heroicons/vue/24/outline'
import { messages } from './i18n'

const props = defineProps<{ language: 'es' | 'en' }>()
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
</script>

<template>
  <section class="content-card">
    <h2>{{ t('accountData') }}</h2>
    <p class="hint">{{ t('accountExportHint') }}</p>
    <a class="secondary" href="/api/me/export" download><ArrowDownTrayIcon class="ui-icon" aria-hidden="true" /> {{ t('accountExport') }}</a>
  </section>
</template>

<style scoped>
a.secondary { display: inline-flex; text-decoration: none; }
</style>
