<script setup lang="ts">
import { computed } from 'vue'
import { DocumentArrowDownIcon } from '@heroicons/vue/24/outline'
import { messages } from './i18n'
import { schematicDownloadUrl } from './schematics'

const props = defineProps<{ url?: string; shareToken?: string | null; language: 'es' | 'en'; badge?: boolean }>()
const href = computed(() => schematicDownloadUrl(props.url, props.shareToken))
const label = computed(() => messages[props.language].downloadSchematic)
</script>

<template>
  <a v-if="href" :href="href" download :class="badge ? 'node-badge schematic nodrag nopan' : 'datasheet-link'"
    :aria-label="label" :title="label" @pointerdown.stop @click.stop>
    <DocumentArrowDownIcon class="ui-icon" aria-hidden="true" />
    <span v-if="!badge">{{ label }}</span>
  </a>
</template>
