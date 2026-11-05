<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { messages } from './i18n'
import { mfaRequest, type MfaChallenge } from './mfa'
import type { User } from './types'
const props = defineProps<{ language: 'es' | 'en'; challenge: MfaChallenge }>()
const emit = defineEmits<{ complete: [user: User]; cancel: [] }>()
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || messages[props.language].mfaFailed
const code = ref(''), recovery = ref(false), reset = ref(false), busy = ref(false), failure = ref(''), input = ref<HTMLInputElement>()
let active = true
const expires = computed(() => new Date(props.challenge.expiresAt).toLocaleTimeString(props.language, { hour: '2-digit', minute: '2-digit' }))
async function submit() {
  busy.value = true; failure.value = ''
  try {
    const result = await mfaRequest(recovery.value && reset.value ? '/login/mfa/recover' : '/login/mfa', { challenge: props.challenge.challenge, code: code.value, ...(reset.value && recovery.value ? {} : { recovery: recovery.value }) }, t, true)
    if (active) emit('complete', result)
  } catch (e) { if (active) failure.value = e instanceof Error ? e.message : t('mfaFailed') }
  finally { code.value = ''; busy.value = false }
}
onMounted(async () => { await nextTick(); input.value?.focus() })
onUnmounted(() => { active = false; code.value = '' })
</script>
<template>
  <h1>{{ t('mfaLoginTitle') }}</h1><p>{{ t('mfaLoginHint') }}</p><p class="hint">{{ t('mfaExpires').replace('{time}', expires) }}</p>
  <form @submit.prevent="submit">
    <fieldset :disabled="busy" class="mfa-fields">
      <label class="mfa-check"><input v-model="recovery" type="checkbox" @change="code=''; reset=false">{{ t('mfaUseRecovery') }}</label>
      <label>{{ t(recovery ? 'mfaRecoveryCode' : 'mfaCode') }}<input ref="input" v-model="code" :inputmode="recovery ? 'text' : 'numeric'" autocomplete="one-time-code" :maxlength="recovery ? 64 : 6" :pattern="recovery ? undefined : '[0-9]{6}'" autocapitalize="characters" :spellcheck="false" required></label>
      <label v-if="recovery" class="mfa-check"><input v-model="reset" type="checkbox">{{ t('mfaLostDevice') }}</label>
      <p v-if="recovery && reset" class="hint">{{ t('mfaLostWarning') }}</p>
      <button class="primary wide">{{ t(recovery && reset ? 'mfaRecoverButton' : 'signIn') }}</button>
      <button type="button" class="link-button" @click="emit('cancel')">{{ t('back') }}</button>
    </fieldset>
  </form>
  <p v-if="failure" class="message error" role="alert">{{ failure }}</p>
</template>
