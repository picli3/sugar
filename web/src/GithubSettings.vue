<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { githubRequest, githubText, type GithubStatus, type GithubCallback, type GithubText } from './github'
const props = defineProps<{ language: 'es' | 'en'; callback?: GithubCallback | null }>()
const emit = defineEmits<{ consumed: [] }>()
const text = (key: GithubText) => githubText(props.language,key)
const status = ref<GithubStatus>(), password = ref(''), busy = ref(false), failure = ref(''), notice = ref(''), confirmed = ref(false)
let active = true
async function refresh() { const value = await githubRequest('/me/github',props.language); if (active) status.value=value }
async function run(task: () => Promise<void>) {
  busy.value=true;failure.value='';notice.value=''
  try { await task() } catch(e) { if(active) failure.value=e instanceof Error?e.message:text('failure') }
  finally { password.value='';confirmed.value=false;if(active) busy.value=false }
}
async function begin() { if (!status.value?.canConnect || busy.value) return; await run(async()=>{
  const value=await githubRequest('/me/github/authorize',props.language,{currentPassword:password.value})
  password.value=''
  const target=new URL(value.authorizationUrl)
  if(target.origin!=='https://github.com'||target.pathname!=='/login/oauth/authorize') throw Error(text('failure'))
  if(active) window.location.assign(target.href)
}) }
async function disconnect() { await run(async()=>{
  const result=await githubRequest('/me/github/disconnect',props.language,{currentPassword:password.value})
  if(active) {notice.value=text(result.remoteRevoked===false?'remotePending':'disconnected');await refresh()}
}) }
onMounted(()=>run(async()=>{
  const callback=props.callback;emit('consumed')
  await refresh()
  if(!callback||!active)return
  if('error' in callback) { failure.value=text(callback.error).replace('{url}',window.location.origin+'/oauth/github/callback')+(callback.received?.length?` (${text('received')}: ${callback.received.join(', ')})`:'');return }
  const result=await githubRequest('/me/github/complete',props.language,callback)
  if(active) { notice.value=text(result.remoteRevocationPending?'remoteReplace':'renewed');await refresh() }
}))
onUnmounted(()=>{active=false;password.value='';confirmed.value=false})
</script>
<template>
  <section class="content-card github-settings">
    <h2>{{ text('title') }}</h2><p class="hint">{{ text('hint') }}</p>
    <p v-if="failure" class="message error" role="alert">{{ failure }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="status?.connected">{{ text('connected') }}: <strong>{{ status.account?.login }}</strong></p>
    <p v-if="status?.needsReauthorization" class="hint">{{ text('reauthorize') }}</p>
    <p v-if="status && !status.canConnect" class="hint">{{ text(status.eligible?'unavailable':'disabled') }}</p>
    <template v-if="status?.canConnect || status?.canDisconnect">
      <form @submit.prevent="begin"><label>{{ text('password') }}<input v-model="password" type="password" autocomplete="current-password" maxlength="1024" required :disabled="busy"></label>
        <button v-if="status.canConnect" class="primary" :disabled="busy || !password">{{ text(status.connected?'reconnect':'connect') }}</button>
        <template v-if="status.canDisconnect"><label class="github-check"><input v-model="confirmed" type="checkbox" :disabled="busy">{{ text('confirmDisconnect') }}</label><button class="secondary" type="button" :disabled="busy || !password || !confirmed" @click="disconnect">{{ text('disconnect') }}</button></template>
      </form>
      <p class="hint">{{ text('installHint') }}</p><p v-if="status.installationUrl"><a :href="status.installationUrl" target="_blank" rel="noreferrer noopener">{{ text('install') }}</a></p>
      <p><a href="https://github.com/settings/connections/applications" target="_blank" rel="noreferrer noopener">{{ text('manage') }}</a></p>
    </template>
    <button type="button" class="link-button" :disabled="busy" @click="run(refresh)">{{ text('refresh') }}</button>
  </section>
</template>
