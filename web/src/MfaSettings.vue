<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { messages } from './i18n'
import { mfaRequest, type MfaSetup, type MfaStatus } from './mfa'
const props = defineProps<{ language: 'es' | 'en'; admin: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const t = (key: string) => (messages[props.language] as Record<string, string>)[key] || messages[props.language].mfaFailed
const status = ref<MfaStatus>(), setup = ref<MfaSetup>(), codes = ref<string[]>([]), password = ref(''), code = ref(''), recovery = ref(false), confirmed = ref(false)
const action = ref<'regenerate' | 'disable' | ''>(''), busy = ref(false), failure = ref(''), notice = ref(''), confirmInput = ref<HTMLInputElement>()
let active = true
const request = (path = '', body?: unknown) => mfaRequest('/me/mfa' + path, body, t)
async function run(task: () => Promise<void>) {
  busy.value = true; failure.value = ''; notice.value = ''
  try { await task() } catch (e) { if (active) failure.value = e instanceof Error ? e.message : t('mfaFailed') }
  finally { password.value = ''; code.value = ''; busy.value = false }
}
async function refresh() { const value = await request(); if (active) status.value = value }
async function begin() { await run(async () => { const value = await request('/enroll', { currentPassword: password.value }); if (active) { setup.value = value; await nextTick(); confirmInput.value?.focus() } }) }
async function confirm() {
  await run(async () => {
    const result = await request('/confirm', { enrollmentId: setup.value!.enrollmentId, code: code.value })
    if (!active) return
    codes.value = result.recoveryCodes; setup.value = undefined; emit('changed'); notice.value = t('mfaSessionsChanged'); await refresh()
  })
}
async function manage() {
  await run(async () => {
    const result = await request(action.value === 'disable' ? '/disable' : '/recovery-codes', { currentPassword: password.value, code: code.value, recovery: recovery.value })
    if (!active) return
    codes.value = result.recoveryCodes || []; action.value = ''; confirmed.value = false; recovery.value = false; emit('changed'); notice.value = t('mfaSessionsChanged'); await refresh()
  })
}
function download() {
  const url = URL.createObjectURL(new Blob(['Sugar — ' + t('mfaRecoveryCode') + '\n\n' + codes.value.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'sugar-recovery-codes.txt'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function cancel() { setup.value = undefined; action.value = ''; password.value = ''; code.value = ''; recovery.value = false; confirmed.value = false }
onMounted(() => run(refresh))
onUnmounted(() => { active = false; cancel(); codes.value = [] })
</script>
<template>
  <section v-if="admin || status?.enabled || failure" class="content-card mfa-settings">
    <h2>{{ t('mfaTitle') }}</h2><p class="hint">{{ t('mfaHint') }}</p>
    <p v-if="failure" class="message error" role="alert">{{ failure }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="codes.length">
      <p role="status">{{ t('mfaCodesHint') }}</p><div class="mfa-codes"><code v-for="value in codes" :key="value">{{ value }}</code></div>
      <div class="header-actions"><button class="secondary" @click="download">{{ t('mfaDownloadCodes') }}</button><button class="primary" @click="codes=[]">{{ t('mfaCodesSaved') }}</button></div>
    </template>
    <form v-else-if="setup" @submit.prevent="confirm">
      <p class="hint">{{ t('mfaSetupHint') }}</p><label>{{ t('mfaSecret') }}<input :value="setup.secret" readonly autocomplete="off" spellcheck="false" @focus="($event.target as HTMLInputElement).select()"></label>
      <p><a :href="setup.uri" rel="noreferrer">{{ t('mfaOpenApp') }}</a></p>
      <label>{{ t('mfaCode') }}<input ref="confirmInput" v-model="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required :disabled="busy"></label>
      <div class="header-actions"><button class="primary" :disabled="busy">{{ t('mfaConfirm') }}</button><button type="button" class="secondary" :disabled="busy" @click="cancel">{{ t('cancel') }}</button></div>
    </form>
    <form v-else-if="action" @submit.prevent="manage">
      <fieldset :disabled="busy" class="mfa-fields">
        <label>{{ t('currentPassword') }}<input v-model="password" type="password" autocomplete="current-password" maxlength="1024" required></label>
        <label class="mfa-check"><input v-model="recovery" type="checkbox" @change="code=''">{{ t('mfaUseRecovery') }}</label>
        <label>{{ t(recovery ? 'mfaRecoveryCode' : 'mfaCode') }}<input v-model="code" :inputmode="recovery ? 'text' : 'numeric'" autocomplete="one-time-code" :maxlength="recovery ? 64 : 6" :pattern="recovery ? undefined : '[0-9]{6}'" autocapitalize="characters" :spellcheck="false" required></label>
        <label v-if="action==='disable'" class="mfa-check"><input v-model="confirmed" type="checkbox" required>{{ t('mfaDisableWarning') }}</label>
        <div class="header-actions"><button class="primary">{{ t(action==='disable' ? 'mfaDisable' : 'mfaRegenerate') }}</button><button type="button" class="secondary" @click="cancel">{{ t('cancel') }}</button></div>
      </fieldset>
    </form>
    <template v-else-if="status">
      <p>{{ t(status.enabled ? 'mfaEnabled' : 'mfaOff') }}</p>
      <template v-if="status.enabled"><p>{{ t('mfaRemaining').replace('{count}', String(status.recoveryCodesRemaining)) }}</p><p class="hint">{{ t('mfaRecoveryHint') }}</p>
        <div class="header-actions"><button class="secondary" :disabled="busy" @click="action='regenerate'">{{ t('mfaRegenerate') }}</button><button class="secondary" :disabled="busy" @click="action='disable'">{{ t('mfaDisable') }}</button></div>
      </template>
      <form v-else-if="status.canEnroll" @submit.prevent="begin"><label>{{ t('currentPassword') }}<input v-model="password" type="password" autocomplete="current-password" maxlength="1024" required :disabled="busy"></label><button class="primary" :disabled="busy">{{ t('mfaBegin') }}</button></form>
      <p v-else class="hint">{{ t('mfaUnavailable') }}</p>
    </template>
    <button class="link-button" :disabled="busy" @click="run(refresh)">{{ t('retry') }}</button>
  </section>
</template>
