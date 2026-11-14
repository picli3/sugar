<script setup lang="ts">
import { computed } from 'vue'
import { collectionOrder, type CollectionFilters, type CollectionSortField } from './collectionView'
const props = defineProps<{ field: CollectionSortField; label: string; filters: CollectionFilters; busy: boolean }>()
const emit = defineEmits<{ sort: [field: CollectionSortField] }>()
const order = computed(() => collectionOrder(props.filters))
const active = computed(() => order.value.sort === props.field)
const ariaSort = computed(() => active.value ? order.value.direction === 'asc' ? 'ascending' : 'descending' : 'none')
</script>

<template>
  <th scope="col" :aria-sort="ariaSort">
    <button type="button" class="collection-sort-button" :disabled="busy" @click="emit('sort', field)">
      {{ label }}<span aria-hidden="true" :class="{ 'sort-active': active }">{{ active ? order.direction === 'asc' ? '↑' : '↓' : '↕' }}</span>
    </button>
  </th>
</template>
