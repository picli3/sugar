<script setup lang="ts">
import YAML from 'yaml'
import { PlusIcon } from '@heroicons/vue/24/outline'
import BlockSymbol from './BlockSymbol.vue'
import type { CategoryIconMap } from './categoryIcons'
import type { LibraryItem } from './types'

const props = defineProps<{ item: LibraryItem; icons: CategoryIconMap; mode: 'palette' | 'library'; selectedId?: string | null; editable: boolean; language?: 'es' | 'en' }>()
const addLabel = () => (props.language === 'en' ? 'Add ' : 'Agregar ') + props.item.name
const emit = defineEmits<{ select: [id: string]; add: [item: LibraryItem]; dragstart: [event: DragEvent, item: LibraryItem] }>()
function block() { try { return YAML.parse(props.item.yaml) || {} } catch { return {} } }
</script>

<template>
  <div v-if="mode === 'palette'" class="palette-item catalog-block" :draggable="editable" @dragstart="emit('dragstart', $event, item)">
    <span class="palette-icon"><BlockSymbol :block="block()" :icons="icons" /></span>
    <div><strong>{{ item.name }}</strong><small>v{{ item.latest_version }}</small></div>
    <button v-if="editable" class="add-small" :aria-label="addLabel()" :title="addLabel()" @click="emit('add', item)"><PlusIcon class="ui-icon" aria-hidden="true" /></button>
  </div>
  <button v-else class="catalog-block library-block" :class="{chosen: selectedId === item.id}" @click="emit('select', item.id)">
    <span class="palette-icon"><BlockSymbol :block="block()" :icons="icons" /></span>
    <span><strong>{{ item.name }}</strong><small>v{{ item.latest_version }}</small></span>
  </button>
</template>
