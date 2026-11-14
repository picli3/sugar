<script setup lang="ts">
import { computed } from 'vue'
import { ArrowTopRightOnSquareIcon, LinkIcon } from '@heroicons/vue/24/outline'
import { propertyUrl } from './propertyDisplay'
import { messages } from './i18n'

const props = defineProps<{ value: unknown; label: string; language: 'es' | 'en' }>()
const href = computed(() => propertyUrl(props.value))
const entries = computed(() => props.value && typeof props.value === 'object' ? Object.entries(props.value) : [])
const labelFor = (key: string) => ['url', 'urls'].includes(key) ? messages[props.language].links : key
</script>

<template>
  <a v-if="href" class="property-link" :href="href" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
    <LinkIcon class="ui-icon" aria-hidden="true" />
    <span>{{ label }}</span><ArrowTopRightOnSquareIcon class="ui-icon property-link-external" aria-hidden="true" />
  </a>
  <ul v-else-if="Array.isArray(value)" class="property-items">
    <li v-for="(item, index) in value" :key="index"><PropertyValue :value="item" :label="label" :language="language" /></li>
  </ul>
  <div v-else-if="value && typeof value === 'object'" class="property-group">
    <div v-for="[key, item] in entries" :key="key" class="property-entry" :class="{ 'property-entry-link': !!propertyUrl(item) }">
      <div v-if="!propertyUrl(item)" class="property-name">{{ labelFor(key) }}</div>
      <PropertyValue :value="item" :label="['url', 'urls'].includes(key) ? messages[language].openLink : key" :language="language" />
    </div>
  </div>
  <div v-else class="property-text">{{ value == null ? '—' : String(value) }}</div>
</template>
