<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { sessionRequest } from './sessionRequest'

// Admin-only view of the durable security log (#23). Shows closed fields only.
type AuditEvent = { id: string; at: string; request_id: string | null; actor: string | null; actor_email: string | null; operation: string; result: string; status: number | null; resource: string | null }
const props = defineProps<{ language: 'es' | 'en' }>()
const copy = {
  es: { title: 'Registro de seguridad', hint: 'Operaciones sensibles de los últimos {days} días: cuenta, operación y resultado. No incluye IP, contenidos ni secretos. El ID de petición coincide con la cabecera X-Request-Id y con los registros del servidor.',
    all: 'Todos los resultados', success: 'Correcto', denied: 'Rechazado', error: 'Error', aborted: 'Interrumpido', filter: 'Resultado', operation: 'Operación (por ejemplo auth o project.share_create)',
    when: 'Fecha', account: 'Cuenta', op: 'Operación', result: 'Resultado', request: 'ID de petición', anonymous: 'Sin sesión', more: 'Cargar más', reload: 'Actualizar', empty: 'No hay eventos con estos filtros.', failed: 'No se pudo cargar el registro.' },
  en: { title: 'Security log', hint: 'Sensitive operations from the last {days} days: account, operation and result. It contains no IP addresses, content or secrets. The request ID matches the X-Request-Id header and the server logs.',
    all: 'All results', success: 'Success', denied: 'Denied', error: 'Error', aborted: 'Interrupted', filter: 'Result', operation: 'Operation (for example auth or project.share_create)',
    when: 'Date', account: 'Account', op: 'Operation', result: 'Result', request: 'Request ID', anonymous: 'No session', more: 'Load more', reload: 'Refresh', empty: 'No events match these filters.', failed: 'The log could not be loaded.' },
}
const t = (key: keyof typeof copy.es) => copy[props.language][key]
const events = ref<AuditEvent[]>([]), next = ref<string | null>(null), days = ref(180), busy = ref(false), failure = ref('')
const result = ref(''), operation = ref('')
let generation = 0
async function load(append = false) {
  const current = ++generation
  busy.value = true; failure.value = ''
  const query = new URLSearchParams({ limit: '50' })
  if (append && next.value) query.set('before', next.value)
  if (result.value) query.set('result', result.value)
  if (operation.value.trim()) query.set('operation', operation.value.trim())
  try {
    const response = await sessionRequest('/api/audit?' + query)
    const body = await response.json()
    if (!response.ok) throw Error(body.error || t('failed'))
    if (current !== generation) return
    events.value = append ? [...events.value, ...body.events] : body.events
    next.value = body.next; days.value = body.retentionDays
  } catch (e) { if (current === generation) failure.value = e instanceof Error ? e.message : t('failed') }
  finally { if (current === generation) busy.value = false }
}
const when = (value: string) => new Date(value).toLocaleString(props.language === 'es' ? 'es' : 'en')
const label = (value: string) => (['success', 'denied', 'error', 'aborted'].includes(value) ? t(value as 'success') : value)
onMounted(() => load())
onUnmounted(() => { generation++ })
</script>

<template>
  <section class="content-card audit-panel">
    <h2>{{ t('title') }}</h2><p class="hint">{{ t('hint').replace('{days}', String(days)) }}</p>
    <form class="audit-filters" @submit.prevent="load()">
      <label>{{ t('filter') }}<select v-model="result" @change="load()"><option value="">{{ t('all') }}</option><option v-for="value in ['success','denied','error','aborted']" :key="value" :value="value">{{ label(value) }}</option></select></label>
      <label>{{ t('operation') }}<input v-model="operation" maxlength="60" pattern="[a-z]+(\.[a-z_]+)?"></label>
      <button class="secondary" type="submit" :disabled="busy">{{ t('reload') }}</button>
    </form>
    <p v-if="failure" class="message error" role="alert">{{ failure }}</p>
    <div class="audit-table-wrap" v-if="events.length">
      <table class="audit-table">
        <thead><tr><th scope="col">{{ t('when') }}</th><th scope="col">{{ t('account') }}</th><th scope="col">{{ t('op') }}</th><th scope="col">{{ t('result') }}</th><th scope="col">{{ t('request') }}</th></tr></thead>
        <tbody><tr v-for="event in events" :key="event.id">
          <td>{{ when(event.at) }}</td><td>{{ event.actor_email || (event.actor ? event.actor.slice(0, 8) : t('anonymous')) }}</td>
          <td><code>{{ event.operation }}</code></td><td :class="'audit-' + event.result">{{ label(event.result) }}{{ event.status ? ' · ' + event.status : '' }}</td>
          <td><code v-if="event.request_id" :title="event.request_id">{{ event.request_id.slice(0, 8) }}</code></td>
        </tr></tbody>
      </table>
    </div>
    <p v-else-if="!busy && !failure" class="hint">{{ t('empty') }}</p>
    <button v-if="next" class="secondary" type="button" :disabled="busy" @click="load(true)">{{ t('more') }}</button>
  </section>
</template>

<style scoped>
.audit-filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 12px; }
.audit-filters label { flex: 1 1 180px; }
.audit-table-wrap { overflow-x: auto; margin-bottom: 12px; }
.audit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.audit-table th, .audit-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border, #d0d7de); white-space: nowrap; }
.audit-error, .audit-aborted { font-weight: 600; }
</style>
