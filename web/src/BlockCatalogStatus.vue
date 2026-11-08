<script setup lang="ts">
import { computed } from 'vue'
import { messages } from './i18n'

const props = defineProps<{
  count: number; status: 'idle' | 'loading' | 'complete' | 'error'; failure: string; language: 'es' | 'en'
}>()
const emit = defineEmits<{ retry: []; refresh: [] }>()
const copy = computed(() => messages[props.language])
</script>

<template>
  <div class="pagination-controls">
    <p class="hint" role="status">
      {{ (status === 'loading' || status === 'idle' ? copy.catalogLoading : copy.blocksLoaded).replace('{count}', String(count)) }}
    </p>
    <p v-if="status === 'error'" class="hint" role="alert">{{ copy.catalogIncomplete }} {{ failure }}</p>
    <button v-if="status === 'error'" type="button" class="secondary wide" @click="emit('retry')">{{ copy.retry }}</button>
    <button v-if="status === 'complete' || status === 'error'" type="button" class="secondary wide" @click="emit('refresh')">{{ copy.catalogRefresh }}</button>
  </div>
</template>
