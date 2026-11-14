<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from 'vue'
import { VueFlow, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { ArrowTopRightOnSquareIcon, CpuChipIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import BlockSymbol from './BlockSymbol.vue'
import PropertyValue from './PropertyValue.vue'
import CanvasControls from './CanvasControls.vue'
import RoutedEdge from './RoutedEdge.vue'
import SchematicDownload from './SchematicDownload.vue'
import { messages } from './i18n'
import { embedTarget } from './embed'
import { sharedImageUrl } from './imageAccess'
import { headerStyle, safeHexColor } from './blockAppearance'
import { isBidirectionalEdge } from './edgeDirection'
import { parseHardwareYaml } from './hardwareYaml'
import type { Diagram, ProjectItem } from './types'

const params = new URLSearchParams(window.location.search)
const language = params.get('lang') === 'en' ? 'en' : 'es'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const t = (key: string) => (messages[language] as Record<string, string>)[key] || key
document.documentElement.lang = language
const target = embedTarget(window.location.pathname, window.location.search)
const project = ref<ProjectItem | null>(null), diagram = ref<Diagram | null>(null)
const error = ref(''), loading = ref(true), selectedId = ref<string | null>(null)
const selected = computed(() => diagram.value?.nodes.find(node => node.id === selectedId.value))
provide('imageUrl', (url: string) => sharedImageUrl(url, target?.shareToken || null))
const nodes = computed(() => diagram.value?.nodes.map(node => ({
  id: node.id, type: 'hardware', position: node.position, data: { block: node.block },
})) || [])
const edges = computed(() => {
  const doc = diagram.value
  if (!doc) return []
  return doc.edges.map(edge => {
    const source = doc.nodes.find(node => node.id === edge.source)?.block.ports.find(port => port.id === edge.sourcePort)
    const destination = doc.nodes.find(node => node.id === edge.target)?.block.ports.find(port => port.id === edge.targetPort)
    return {
      id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourcePort, targetHandle: edge.targetPort,
      type: 'routed', label: source?.protocol || '', data: {
        route: edge.route, editable: false, bidirectional: isBidirectionalEdge(edge, doc),
        labelColor: theme === 'light' ? '#28241f' : '#f2ece5',
        color: safeHexColor(source?.color) || safeHexColor(destination?.color) || (theme === 'light' ? '#c95016' : '#f28b45'),
      },
    }
  })
})
const frame = ref<HTMLElement>()
const { fitView } = useVueFlow()
let controller: AbortController | null = null, observer: ResizeObserver | undefined
let timer: ReturnType<typeof setTimeout> | undefined, resizing: ReturnType<typeof setTimeout> | undefined
let disposed = false

async function refresh() {
  if (disposed || controller || document.hidden) return
  clearTimeout(timer)
  if (!target) { error.value = t('embedUnavailable'); loading.value = false; return }
  controller = new AbortController()
  const timeout = setTimeout(() => controller?.abort(), 15000)
  let failure = t('embedUnavailable')
  try {
    const response = await fetch('/api' + target.apiPath, { credentials: 'omit', cache: 'no-store', signal: controller.signal })
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) { project.value = null; diagram.value = null; selectedId.value = null }
      failure = t(response.status === 429 ? 'embedRateLimit' : 'embedUnavailable')
      throw Error(failure)
    }
    const result = await response.json() as ProjectItem
    if (disposed) return
    document.title = result.name + ' · Sugar'
    const initial = !project.value
    if (!project.value || project.value.yaml !== result.yaml) diagram.value = parseHardwareYaml(result.yaml || '') as Diagram
    project.value = result
    error.value = ''
    if (initial) { await nextTick(); await fitView({ padding: 0.15, maxZoom: 1 }) }
  } catch {
    if (!disposed) error.value = failure
  } finally {
    clearTimeout(timeout)
    controller = null
    loading.value = false
    if (!disposed) timer = setTimeout(refresh, 30000)
  }
}
function visible() {
  clearTimeout(timer)
  if (!document.hidden) void refresh()
}
onMounted(() => {
  void refresh()
  document.addEventListener('visibilitychange', visible)
  if (frame.value) {
    observer = new ResizeObserver(() => {
      clearTimeout(resizing)
      resizing = setTimeout(() => { if (project.value) void fitView({ padding: 0.15, maxZoom: 1 }) }, 100)
    })
    observer.observe(frame.value)
  }
})
onUnmounted(() => {
  disposed = true; controller?.abort(); observer?.disconnect()
  clearTimeout(timer); clearTimeout(resizing)
  document.removeEventListener('visibilitychange', visible)
})
</script>

<template>
  <main class="app-shell embed-view" :class="theme">
    <header class="embed-header">
      <a v-if="target" :href="target.openPath" target="_blank" rel="noopener noreferrer" :aria-label="t('embedOpen')">
        <img src="/sugar-mark.png" alt="" width="24" height="24"><strong>Sugar</strong>
        <ArrowTopRightOnSquareIcon class="ui-icon" aria-hidden="true" />
      </a>
      <span>{{ project?.name || t('sharedProject') }}</span>
    </header>
    <p v-if="loading" class="embed-status" role="status">{{ t('collectionLoading') }}</p>
    <div v-else-if="error" class="embed-status" role="status">{{ error }} <span v-if="project">{{ t('embedLastVersion') }}</span> <button class="link-button" @click="refresh">{{ t('retry') }}</button></div>
    <div ref="frame" class="embed-canvas">
      <VueFlow v-if="project" :nodes="nodes" :edges="edges" :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="true"
        :delete-key-code="null" :min-zoom="0.05" fit-view-on-init @node-click="selectedId=$event.node.id" @pane-click="selectedId=null">
        <Background pattern-color="#8b95a8" :gap="20" :size="1" />
        <CanvasControls :language="language" :show-interactive="false" />
        <template #edge-routed="edgeProps"><RoutedEdge v-bind="edgeProps" /></template>
        <template #node-hardware="{ data }">
          <div class="hardware-node">
            <div class="node-header" :class="{ 'has-custom-color': !!safeHexColor(data.block.color) }" :style="headerStyle(data.block.color)">
              <span class="node-symbol"><BlockSymbol :block="data.block" :icons="project.category_icons || {}" class="icon-node" /></span>
              <strong>{{ data.block.name }}</strong>
            </div>
            <div class="node-model">{{ data.block.model || data.block.function }}</div>
            <div v-for="port in data.block.ports" :key="port.id" class="node-port">
              <Handle v-if="port.direction !== 'out'" :id="port.id" type="target" :position="Position.Left" :style="safeHexColor(port.color) ? { backgroundColor: port.color } : undefined" />
              <span>{{ port.label }}</span><em>{{ port.protocol }}</em>
              <Handle v-if="port.direction !== 'in'" :id="port.id" type="source" :position="Position.Right" :style="safeHexColor(port.color) ? { backgroundColor: port.color } : undefined" />
            </div>
          </div>
        </template>
      </VueFlow>
      <div v-if="project && !nodes.length" class="canvas-hint"><CpuChipIcon class="ui-icon icon-empty" aria-hidden="true" /><p>{{ t('noBlocks') }}</p></div>
      <aside v-if="selected" class="embed-details" :aria-label="t('blockProperties')">
        <button class="icon-button" :aria-label="t('embedClose')" @click="selectedId=null"><XMarkIcon class="ui-icon" aria-hidden="true" /></button>
        <h2>{{ selected.block.name }}</h2>
        <p>{{ selected.block.function }}</p><p v-if="selected.block.model">{{ selected.block.model }}</p>
        <SchematicDownload :url="selected.block.design_block_kicad" :share-token="target?.shareToken" :language="language" />
        <section v-if="Object.keys(selected.block.properties || {}).length" class="embed-properties" :aria-label="t('blockProperties')">
          <h3>{{ t('blockProperties') }}</h3>
          <PropertyValue :value="selected.block.properties" :label="t('blockProperties')" :language="language" />
        </section>
      </aside>
    </div>
  </main>
</template>
