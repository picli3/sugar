<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { aiApi, aiMessages, type AiConfig } from './ai'
const props = defineProps<{ language: 'es' | 'en' }>()
const t = (key: string) => (aiMessages[props.language] as Record<string,string>)[key] || key
const config = ref<AiConfig>({ provider: 'deepseek', model: 'deepseek-flash', enabled: false, tokenConfigured: false, encryptionReady: false })
const savedProvider = ref('deepseek')
const token = ref(''), busy = ref(false), error = ref(''), message = ref(''), loaded = ref(false), saved = ref('')
const dirty = computed(() => !!token.value || JSON.stringify(config.value) !== saved.value)
async function run(fn: () => Promise<void>) { busy.value = true; error.value = ''; message.value = ''; try { await fn() } catch(e) { error.value = e instanceof Error ? e.message : 'aiNetworkError' } finally { busy.value = false } }
function accept(c: AiConfig) { config.value = c; saved.value = JSON.stringify(c); savedProvider.value = c.provider; token.value = ''; loaded.value = true }
const providerChanged = computed(() => loaded.value && config.value.provider !== savedProvider.value)
// A new provider starts from its suggested model, if any; the previous key is never reused (#30).
function chooseProvider(id: string) { config.value = { ...config.value, provider: id, model: config.value.providers?.find(p => p.id === id)?.defaultModel || '' } }
onMounted(() => run(async () => accept(await aiApi('/ai'))))
async function save(removeToken = false) { await run(async () => { accept(await aiApi('/ai', 'PUT', { provider: config.value.provider, model: config.value.model, enabled: removeToken ? false : config.value.enabled, token: removeToken ? '' : token.value, removeToken })); message.value = t('aiSave') + ' ✓' }) }
async function test() { await run(async () => { await aiApi('/ai/test', 'POST', { requestId: crypto.randomUUID() }); message.value = t('aiTestOk') }) }
</script>
<template>
  <section class="content-card ai-settings">
    <h2>{{ t('aiTitle') }}</h2><p class="hint">{{ t('aiConfigHint') }}</p>
    <p v-if="error" class="message error" role="alert">{{ t(error) }}</p><p v-if="message" class="message success" role="status">{{ message }}</p>
    <fieldset :disabled="busy || !loaded">
      <label>{{ t('aiProvider') }}<select :value="config.provider" @change="chooseProvider(($event.target as HTMLSelectElement).value)"><option v-for="provider in config.providers || []" :key="provider.id" :value="provider.id">{{ provider.label }}</option></select></label>
      <p v-if="providerChanged" class="hint" role="status">{{ t('aiProviderChanged') }}</p>
      <label>{{ t('aiModelId') }}<input v-model.trim="config.model" maxlength="128" autocomplete="off" spellcheck="false" required></label>
      <p class="hint">{{ t('aiModelHint') }}</p>
      <label>{{ t('aiToken') }}<input v-model="token" type="password" autocomplete="new-password" maxlength="4096" :placeholder="config.tokenConfigured ? '••••••••' : ''"></label>
      <p class="hint">{{ config.tokenConfigured ? t('aiTokenSaved') : t('aiTokenEmpty') }}</p>
      <label class="ai-enable"><input v-model="config.enabled" type="checkbox">{{ t('aiEnabled') }}</label>
      <div class="ai-actions"><button class="primary" @click="save()">{{ t('aiSave') }}</button><button class="secondary" :disabled="!config.tokenConfigured || dirty" @click="test">{{ t('aiTest') }}</button><button v-if="config.tokenConfigured" class="text-danger" @click="save(true)">{{ t('aiRemoveToken') }}</button></div>
    </fieldset>
    <p v-if="loaded && !config.encryptionReady" class="message error">{{ t('aiKeyMissing') }}</p><p class="hint">{{ t('aiEncryptionHint') }}</p>
  </section>
</template>
