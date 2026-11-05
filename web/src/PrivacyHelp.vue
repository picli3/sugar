<script setup lang="ts">
import { computed } from 'vue'
import { privacyContent } from './privacyContent'

const props = defineProps<{ language: 'es' | 'en' }>()
const emit = defineEmits<{ close: [] }>()
const content = computed(() => privacyContent[props.language])
// Turn plain URLs and the support address into links without rendering HTML from data.
const parts = (text: string) => text.split(/(https:\/\/[^\s)]*[^\s).,;]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g).filter(Boolean).map(value =>
  /^https:\/\//.test(value) ? { value, href: value } : /@/.test(value) && !/\s/.test(value) ? { value, href: 'mailto:' + value } : { value, href: '' })
</script>

<template>
  <div class="privacy-screen">
    <article class="privacy-card">
      <div class="brand-lockup"><img src="/sugar-mark.png" alt="" width="32" height="32"><span>Sugar</span></div>
      <h1>{{ content.title }}</h1>
      <p class="privacy-status" role="note">{{ content.status }}</p>
      <p class="hint">{{ content.updated }}</p>
      <nav :aria-label="content.title"><a v-for="section in content.sections" :key="section.id" :href="'#privacy-' + section.id">{{ section.heading }}</a></nav>
      <section v-for="section in content.sections" :id="'privacy-' + section.id" :key="section.id">
        <h2>{{ section.heading }}</h2>
        <p v-for="(paragraph, index) in section.paragraphs" :key="index"><template v-for="(part, at) in parts(paragraph)" :key="at"><a v-if="part.href" :href="part.href" rel="noopener noreferrer" :target="part.href.startsWith('https:') ? '_blank' : undefined">{{ part.value }}</a><template v-else>{{ part.value }}</template></template></p>
        <ul v-if="section.items"><li v-for="(item, index) in section.items" :key="index">{{ item }}</li></ul>
      </section>
      <button class="secondary" type="button" @click="emit('close')">{{ content.back }}</button>
    </article>
  </div>
</template>

<style scoped>
.privacy-screen { min-height: 100%; overflow-y: auto; background: var(--bg); color: var(--text); padding: 32px 16px; }
.privacy-card { max-width: 760px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: 13px; padding: 28px; line-height: 1.55; }
.privacy-card h1 { margin: 16px 0 10px; font: 600 30px/1.2 'Space Grotesk', sans-serif; }
.privacy-card h2 { margin: 28px 0 8px; font: 600 19px/1.3 'Space Grotesk', sans-serif; }
.privacy-card p { margin: 0 0 8px; }
.privacy-status { border-left: 3px solid var(--accent); padding: 8px 12px; background: var(--surface2); border-radius: 6px; }
.privacy-card nav { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 12px 0; font-size: 13px; }
.privacy-card a { color: var(--accent); overflow-wrap: anywhere; }
.privacy-card ul { list-style: disc; padding-left: 22px; margin: 4px 0 8px; }
.privacy-card li { margin: 4px 0; }
.privacy-card > button { margin-top: 24px; }
@media (max-width: 600px) { .privacy-card { padding: 20px; } }
</style>
