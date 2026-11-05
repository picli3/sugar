<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { sessionRequest } from './sessionRequest'
import { messages } from './i18n'
const props = defineProps<{ kind: 'project' | 'block' | 'comparison'; language: 'es' | 'en' }>()
const limits = ref<Record<string, number> | null>(null)
const text = computed(() => {
  let result: string = messages[props.language][props.kind === 'comparison' ? 'comparisonLimitsHint' : props.kind === 'project' ? 'projectLimitsHint' : 'blockLimitsHint']
  for (const [key, value] of Object.entries(limits.value || {})) result = result.replaceAll('{' + key + '}', String(value))
  return result
})
onMounted(async () => {
  try { const response = await sessionRequest('/api/document-limits'); if (response.ok) limits.value = await response.json() } catch { /* Saving still validates authoritative limits on the server. */ }
})
</script>

<template><p v-if="limits" class="hint" role="note">{{ text }}</p></template>
