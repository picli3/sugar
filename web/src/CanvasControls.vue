<script setup lang="ts">
import { computed } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import { ControlButton, Controls } from '@vue-flow/controls'
import { ArrowsPointingOutIcon, LockClosedIcon, LockOpenIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from '@heroicons/vue/24/outline'
import { messages } from './i18n'

// Same behavior as the default Vue Flow controls, with names screen readers can announce (#28).
const props = defineProps<{ language: 'es' | 'en'; showInteractive?: boolean }>()
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || key
const { nodesDraggable, nodesConnectable, elementsSelectable, setInteractive, zoomIn, zoomOut, fitView, viewport, minZoom, maxZoom } = useVueFlow()
const interactive = computed(() => nodesDraggable.value || nodesConnectable.value || elementsSelectable.value)
const atMin = computed(() => viewport.value.zoom <= minZoom.value), atMax = computed(() => viewport.value.zoom >= maxZoom.value)
</script>

<template>
  <Controls :show-zoom="false" :show-fit-view="false" :show-interactive="false">
    <ControlButton :aria-label="t('canvasZoomIn')" :title="t('canvasZoomIn')" :disabled="atMax" @click="zoomIn()"><MagnifyingGlassPlusIcon aria-hidden="true" /></ControlButton>
    <ControlButton :aria-label="t('canvasZoomOut')" :title="t('canvasZoomOut')" :disabled="atMin" @click="zoomOut()"><MagnifyingGlassMinusIcon aria-hidden="true" /></ControlButton>
    <ControlButton :aria-label="t('canvasFitView')" :title="t('canvasFitView')" @click="fitView()"><ArrowsPointingOutIcon aria-hidden="true" /></ControlButton>
    <ControlButton v-if="showInteractive !== false" :aria-label="t('canvasLock')" :title="t('canvasLock')" :aria-pressed="!interactive" @click="setInteractive(!interactive)"><LockClosedIcon v-if="!interactive" aria-hidden="true" /><LockOpenIcon v-else aria-hidden="true" /></ControlButton>
  </Controls>
</template>
