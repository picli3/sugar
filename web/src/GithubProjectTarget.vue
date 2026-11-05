<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ProjectItem } from './types'
import { githubRequest, githubText, type GithubStatus, type GithubTarget, type GithubInstallation, type GithubRepository, type GithubText } from './github'
const props=defineProps<{project:ProjectItem;userId:string;language:'es'|'en'}>()
const emit=defineEmits<{updated:[project:ProjectItem];refresh:[]}>()
const text=(key:GithubText)=>githubText(props.language,key),own=computed(()=>props.project.created_by===props.userId)
const status=ref<GithubStatus>(),target=ref<GithubTarget>(),installations=ref<GithubInstallation[]>([]),repositories=ref<GithubRepository[]>([])
const installationId=ref(''),repositoryId=ref(''),branch=ref(props.project.sync_branch||'main'),consent=ref(false),loaded=ref(false),busy=ref(false),failure=ref(''),notice=ref('')
const selected=computed(()=>repositories.value.find(row=>row.id===repositoryId.value))
let active=true
async function run(task:()=>Promise<void>) {
  if(busy.value)return
  busy.value=true;failure.value='';notice.value=''
  try{await task()}catch(e){if(active)failure.value=e instanceof Error?e.message:text('failure')}
  finally{if(active)busy.value=false}
}
async function refresh(){
  if(!own.value)return
  const [account,destination]=await Promise.all([githubRequest('/me/github',props.language),githubRequest(`/projects/${props.project.id}/github-target`,props.language)])
  if(active){status.value=account;target.value=destination}
}
function selectRepository(){const repo=selected.value;consent.value=false;if(repo)branch.value=repo.name===props.project.sync_repository?(props.project.sync_branch||'main'):repo.defaultBranch}
async function loadRepositories(){
  repositories.value=[];repositoryId.value='';consent.value=false
  if(!installationId.value)return
  const rows=await githubRequest(`/me/github/installations/${installationId.value}/repositories`,props.language)
  if(!active)return
  repositories.value=rows
  repositoryId.value=rows.find((row:GithubRepository)=>row.name===props.project.sync_repository)?.id||rows[0]?.id||''
  selectRepository()
}
async function load(){await run(async()=>{
  const rows:GithubInstallation[]=await githubRequest('/me/github/installations',props.language)
  if(!active)return
  installations.value=rows.filter(row=>row.writable);loaded.value=true
  installationId.value=installations.value.find(row=>row.id===target.value?.target?.installationId)?.id||installations.value[0]?.id||''
  await loadRepositories()
})}
async function save(remove=false){await run(async()=>{
  if(!own.value||(!remove&&!selected.value))return
  const body={visibility:props.project.visibility,expectedSettingsVersion:props.project.settings_version,
    sync_repository:remove?'':selected.value!.name,sync_branch:remove?'main':branch.value,
    ...(!remove?{sync_installation_id:installationId.value,sync_repository_id:repositoryId.value,sync_confirm_public:consent.value}:{})}
  const value=await githubRequest(`/projects/${props.project.id}/settings`,props.language,body,'PATCH')
  if(active){emit('updated',value);consent.value=false;notice.value=text('saved');await refresh()}
})}
async function retry(){await run(async()=>{await githubRequest(`/projects/${props.project.id}/sync/retry`,props.language,{});if(active)emit('refresh')})}
onMounted(()=>run(refresh));onUnmounted(()=>{active=false;repositories.value=[];installations.value=[]})
</script>
<template>
  <section class="github-project-target">
    <h3>{{ text('destination') }}</h3>
    <p v-if="!own" class="hint">{{ text('ownerOnly') }}</p>
    <template v-else>
      <p v-if="failure" class="message error" role="alert">{{ failure }}</p><p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="project.sync_repository" class="github-current"><strong>{{ project.sync_repository }}</strong> · {{ project.sync_branch }}</p>
      <p v-if="target" class="hint">{{ text(target.authorized?'authorized':'paused') }}</p>
      <p class="hint">{{ text('settings') }}</p>
      <button v-if="status?.connected && status.configured && !status.needsReauthorization" class="secondary wide" :disabled="busy" type="button" @click="load">{{ text('load') }}</button>
      <p v-else-if="status?.needsReauthorization" class="hint">{{ text('reauthorize') }}</p>
      <p v-else-if="status && !status.configured" class="hint">{{ text('unavailable') }}</p>
      <template v-if="loaded">
        <label v-if="installations.length">{{ text('installation') }}<select :aria-label="text('installation')" v-model="installationId" :disabled="busy" @change="run(loadRepositories)"><option v-for="row in installations" :key="row.id" :value="row.id">{{ row.login }}</option></select></label>
        <form v-if="repositories.length" @submit.prevent="save()">
          <label>{{ text('repository') }}<select :aria-label="text('repository')" v-model="repositoryId" required :disabled="busy" @change="selectRepository"><option v-for="row in repositories" :key="row.id" :value="row.id">{{ row.name }}{{ row.private?'':' · '+text('publicLabel') }}</option></select></label>
          <label>{{ text('branch') }}<input v-model="branch" required maxlength="256" :disabled="busy" spellcheck="false"></label>
          <label v-if="selected && !selected.private" class="github-check"><input v-model="consent" type="checkbox" required :disabled="busy">{{ text('publicConsent') }}</label>
          <button class="primary wide" :disabled="busy || !selected || !branch || (!selected.private && !consent)">{{ text('save') }}</button>
        </form>
        <p v-else-if="!busy" class="hint">{{ text('empty') }}</p>
      </template>
      <div class="header-actions"><button v-if="project.sync_repository" type="button" class="link-button" :disabled="busy" @click="save(true)">{{ text('remove') }}</button><button v-if="target?.authorized" type="button" class="link-button" :disabled="busy" @click="retry">{{ text('retry') }}</button></div>
    </template>
  </section>
</template>
