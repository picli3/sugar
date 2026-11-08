<script setup lang="ts">
import { computed } from 'vue'
import { DocumentArrowDownIcon, PlusIcon } from '@heroicons/vue/24/outline'
import { messages } from './i18n'
import BlockSymbol from './BlockSymbol.vue'
import type { CategoryIconMap } from './categoryIcons'
import type { CatalogBlockItem } from './types'

const props = defineProps<{ item: CatalogBlockItem; icons: CategoryIconMap; mode: 'palette' | 'library'; selectedId?: string | null; editable: boolean; language?: 'es' | 'en' }>()
const addLabel = () => (props.language === 'en' ? 'Add ' : 'Agregar ') + props.item.name
const emit = defineEmits<{ select: [id: string]; add: [item: CatalogBlockItem]; dragstart: [event: DragEvent, item: CatalogBlockItem] }>()
const block = computed(() => ({
  image: props.item.image || undefined,
  category: props.item.category || undefined,
  subcategory: props.item.subcategory || undefined,
}))
const schematicLabel = computed(() => messages[props.language || 'es'].schematic)
</script>

<template>
  <div v-if="mode === 'palette'" class="palette-item catalog-block" :draggable="editable" @dragstart="emit('dragstart', $event, item)">
    <span class="palette-icon"><BlockSymbol :block="block" :icons="icons" lazy /></span>
    <div><strong>{{ item.name }}</strong><small>v{{ item.latest_version }} <span v-if="item.has_schematic" role="img" :aria-label="schematicLabel" :title="schematicLabel"><DocumentArrowDownIcon class="ui-icon catalog-schematic" aria-hidden="true" /></span></small></div>
    <button v-if="editable" class="add-small" :aria-label="addLabel()" :title="addLabel()" @click="emit('add', item)"><PlusIcon class="ui-icon" aria-hidden="true" /></button>
  </div>
  <button v-else class="catalog-block library-block" :class="{chosen: selectedId === item.id}" @click="emit('select', item.id)">
    <span class="palette-icon"><BlockSymbol :block="block" :icons="icons" lazy /></span>
    <span><strong>{{ item.name }}</strong><small>v{{ item.latest_version }} <span v-if="item.has_schematic" role="img" :aria-label="schematicLabel" :title="schematicLabel"><DocumentArrowDownIcon class="ui-icon catalog-schematic" aria-hidden="true" /></span></small></span>
  </button>
</template>
