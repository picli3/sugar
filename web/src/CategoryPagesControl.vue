<script setup lang="ts">
import { messages } from './i18n'
defineProps<{ cursor: string | null; loading: boolean; count: number; language: 'es' | 'en' }>()
defineEmits<{ more: [] }>()
</script>
<template>
  <div class="pagination-controls category-pagination">
    <button v-if="cursor" class="secondary" :disabled="loading" @click="$emit('more')">{{ messages[language].loadMoreCategories }}</button>
    <p class="hint" role="status">{{ messages[language].categoriesAvailable.replace('{count}', String(count)) }}</p>
    <p v-if="cursor" class="hint">{{ messages[language].categoryOptionsHint }}</p>
  </div>
</template>
