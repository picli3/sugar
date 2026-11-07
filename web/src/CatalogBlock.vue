<script setup lang="ts">
import YAML from 'yaml'
import { computed } from 'vue'
import { DocumentArrowDownIcon, PlusIcon } from '@heroicons/vue/24/outline'
import { messages } from './i18n'
import { schematicDownloadUrl } from './schematics'
import BlockSymbol from './BlockSymbol.vue'
import type { CategoryIconMap } from './categoryIcons'
import type { LibraryItem } from './types'

const props = defineProps<{ item: LibraryItem; icons: CategoryIconMap; mode: 'palette' | 'library'; selectedId?: string | null; editable: boolean; language?: 'es' | 'en' }>()
const addLabel = () => (props.language === 'en' ? 'Add ' : 'Agregar ') + props.item.name
const emit = defineEmits<{ select: [id: string]; add: [item: LibraryItem]; dragstart: [event: DragEvent, item: LibraryItem] }>()
const block = computed(() => {
  try { return YAML.parse(props.item.yaml) || {} } catch { return {} }
})
const hasSchematic = computed(() => !!schematicDownloadUrl(block.value.design_block_kicad))
const schematicLabel = computed(() => messages[props.language || 'es'].schematic)
</script>

<template>
  <div v-if="mode === 'palette'" class="palette-item catalog-block" :draggable="editable" @dragstart="emit('dragstart', $event, item)">
    <span class="palette-icon"><BlockSymbol :block="block" :icons="icons" /></span>
    <div><strong>{{ item.name }}</strong><small>v{{ item.latest_version }} <DocumentArrowDownIcon v-if="hasSchematic" class="ui-icon catalog-schematic" role="img" :aria-label="schematicLabel"><title>{{ schematicLabel }}</title></DocumentArrowDownIcon></small></div>
    <button v-if="editable" class="add-small" :aria-label="addLabel()" :title="addLabel()" @click="emit('add', item)"><PlusIcon class="ui-icon" aria-hidden="true" /></button>
  </div>
  <button v-else class="catalog-block library-block" :class="{chosen: selectedId === item.id}" @click="emit('select', item.id)">
    <span class="palette-icon"><BlockSymbol :block="block" :icons="icons" /></span>
    <span><strong>{{ item.name }}</strong><small>v{{ item.latest_version }} <DocumentArrowDownIcon v-if="hasSchematic" class="ui-icon catalog-schematic" role="img" :aria-label="schematicLabel"><title>{{ schematicLabel }}</title></DocumentArrowDownIcon></small></span>
  </button>
</template>
