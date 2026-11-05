<script setup lang="ts">
import { computed } from 'vue'
import { gettingStarted } from './helpContent'
import { templateIds, templateInfo, type TemplateId } from './projectTemplates'

const props = defineProps<{ language: 'es' | 'en'; editable: boolean; busy: boolean }>()
const emit = defineEmits<{ create: [template: TemplateId] }>()
const copy = computed(() => gettingStarted[props.language])
const templates = computed(() => templateIds.map(id => templateInfo(id, props.language)))
</script>

<template>
  <section class="content-card getting-started" :aria-labelledby="'getting-started-title'">
    <h2 id="getting-started-title">{{ copy.title }}</h2>
    <p class="hint">{{ copy.intro }}</p>
    <ol><li v-for="(step, index) in copy.steps" :key="index">{{ step }}</li></ol>
    <template v-if="editable">
      <h3>{{ copy.templatesTitle }}</h3>
      <p class="hint">{{ copy.templatesHint }}</p>
      <div class="template-grid">
        <article v-for="template in templates" :key="template.id" class="template-card">
          <strong>{{ template.name }}</strong><small>{{ template.description }}</small>
          <button class="secondary" type="button" :disabled="busy" :aria-label="copy.create + ': ' + template.name" @click="emit('create', template.id)">{{ copy.create }}</button>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.getting-started { margin: 0 48px 25px; }
.getting-started ol { list-style: decimal; padding-left: 22px; display: grid; gap: 6px; margin: 12px 0 4px; }
.getting-started h3 { margin: 20px 0 4px; font-weight: 700; }
.template-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 10px; }
.template-card { display: grid; gap: 6px; align-content: start; border: 1px solid var(--border); border-radius: 11px; padding: 14px; background: var(--surface2); }
.template-card button { justify-self: start; margin-top: 4px; }
@media (max-width: 900px) { .getting-started { margin: 0 30px 25px; } }
@media (max-width: 600px) { .getting-started { margin: 0 20px 20px; } }
</style>
