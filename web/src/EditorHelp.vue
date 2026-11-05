<script setup lang="ts">
import { computed } from 'vue'
import { editorHelp } from './helpContent'

const props = defineProps<{ language: 'es' | 'en' }>()
const emit = defineEmits<{ privacy: [] }>()
const help = computed(() => editorHelp[props.language])
</script>

<template>
  <div class="editor-help">
    <h2>{{ help.title }}</h2>
    <section v-for="section in help.sections" :key="section.id">
      <h3>{{ section.heading }}</h3>
      <ul><li v-for="(item, index) in section.items" :key="index">{{ item }}</li></ul>
      <pre v-if="section.example" class="yaml-example"><code>{{ section.example }}</code></pre>
    </section>
    <button class="link-button" type="button" @click="emit('privacy')">{{ language === 'en' ? 'Privacy and help' : 'Privacidad y ayuda' }}</button>
  </div>
</template>

<style scoped>
.editor-help { display: grid; gap: 4px; padding: 4px 2px 16px; font-size: 13px; line-height: 1.5; }
.editor-help h2 { font: 600 17px 'Space Grotesk', sans-serif; margin: 4px 0 6px; }
.editor-help h3 { font-weight: 700; margin: 12px 0 4px; }
.editor-help ul { list-style: disc; padding-left: 18px; display: grid; gap: 4px; }
.yaml-example { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; overflow-x: auto; font-size: 12px; margin: 6px 0 0; }
.editor-help .link-button { justify-self: start; margin-top: 12px; }
</style>
