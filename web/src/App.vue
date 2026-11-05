<script setup lang="ts">
import { usePagedList } from './pagination'
import { useCategoryContext } from './categoryContext'
import CategoryPagesControl from './CategoryPagesControl.vue'
import DocumentLimitsHint from './DocumentLimitsHint.vue'
import ImageStoragePanel from './ImageStoragePanel.vue'
import DocumentStoragePanel from './DocumentStoragePanel.vue'
import TotalStoragePanel from './TotalStoragePanel.vue'
import TrashPanel from './TrashPanel.vue'
import MfaSettings from './MfaSettings.vue'
import MfaLoginForm from './MfaLoginForm.vue'
import type { MfaChallenge } from './mfa'
import { sessionRequest } from './sessionRequest'
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { VueFlow, Handle, Position, useVueFlow, type Connection } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { toPng, toSvg } from 'html-to-image'
import { createExportFrame } from './exportFrame'
import YAML from 'yaml'
import { ArrowDownTrayIcon, ArrowPathIcon, ArrowRightStartOnRectangleIcon, ArrowTopRightOnSquareIcon, ArrowUpTrayIcon, Bars3Icon, ChevronDoubleLeftIcon, ChevronDoubleRightIcon, CheckCircleIcon, ClockIcon, CodeBracketIcon, Cog6ToothIcon, CpuChipIcon, CubeIcon, DocumentTextIcon, ExclamationCircleIcon, FolderIcon, LinkIcon, MoonIcon, PhotoIcon, PlusIcon, RectangleGroupIcon, ShareIcon, SparklesIcon, SunIcon, TrashIcon, UsersIcon, WrenchScrewdriverIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import BlockSymbol from './BlockSymbol.vue'
import { sharedImageUrl } from './imageAccess'
import CategorySymbol from './CategorySymbol.vue'
import IconPicker from './IconPicker.vue'
import type { CategoryIconMap, CategoryIconKey } from './categoryIcons'
import AiSettings from './AiSettings.vue'
import AiQuotaSettings from './AiQuotaSettings.vue'
import AiPanel from './AiPanel.vue'
import ProjectMembers from './ProjectMembers.vue'
import SessionsPanel from './SessionsPanel.vue'
import RegistrationForm from './RegistrationForm.vue'
import MailSettings from './MailSettings.vue'
import AccountRecoveryForm from './AccountRecoveryForm.vue'
import AccountEmailSettings from './AccountEmailSettings.vue'
import { takeAccountAction } from './accountRecovery'
import { takeVerificationToken } from './registration'
import RoutedEdge from './RoutedEdge.vue'
import BlockCatalog from './BlockCatalog.vue'
import { headerStyle, safeHexColor } from './blockAppearance'
import { isBidirectionalEdge as bothPortsBidirectional } from './edgeDirection'
import { messages } from './i18n'
import type { Block, Category, Diagram, DiagramNode, LibraryItem, ProjectItem, Revision, User } from './types'

const user = ref<User | null>(null)
const sidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') !== 'false')
const paletteCollapsed = ref(false)
const yamlPanelWidth = ref(Math.min(800, Math.max(300, Number(localStorage.getItem('yamlPanelWidth')) || 380)))
const libraryWide = ref(localStorage.getItem('libraryWide') === 'true')
watch(yamlPanelWidth, value => localStorage.setItem('yamlPanelWidth', String(value)))
watch(libraryWide, value => localStorage.setItem('libraryWide', String(value)))
watch(sidebarCollapsed, value => localStorage.setItem('sidebarCollapsed', String(value)))
const page = ref<'projects' | 'editor' | 'library' | 'gallery' | 'trash' | 'users' | 'settings'>('projects')
const busy = ref(false), notice = ref(''), errorMessage = ref('')
const loginEmail = ref(''), loginPassword = ref(''), mfaChallenge = ref<MfaChallenge>(), mfaSessionEpoch = ref(0)
const publicLanguage = ref<'es' | 'en'>('es'), registrationEnabled = ref(false), registrationOpen = ref(false)
const verificationToken = ref(takeVerificationToken(window.location, window.history))
const accountAction = ref(takeAccountAction(window.location, window.history)), recoveryOpen = ref(false), recoveryEnabled = ref(false)
const projectPages = usePagedList<ProjectItem>(path => api(path), '/projects/page', item => item.id)
const projects = projectPages.items, projectsCursor = projectPages.cursor, projectsLoading = projectPages.loading
const blockPages = usePagedList<LibraryItem>(path => api(path), '/blocks/page', item => item.id)
const blocks = blockPages.items, blocksCursor = blockPages.cursor, blocksLoading = blockPages.loading
const userPages = usePagedList<User>(path => api(path), '/users/page', item => item.id)
const users = userPages.items, usersCursor = userPages.cursor, usersLoading = userPages.loading
const categoryContext = useCategoryContext(api)
const categories = categoryContext.items, categoriesCursor = categoryContext.pages.cursor, categoriesLoading = categoryContext.loading
const projectIcons = ref<CategoryIconMap>({})
let projectIconGeneration = 0
const newCategoryName = ref(''), newCategoryParent = ref(''), categoryEdits = ref<Record<string, string>>({})
const newCategoryIcon = ref<string | null>(''), categoryIconEdits = ref<Record<string, CategoryIconKey | null>>({})
watch(newCategoryParent, parent => { newCategoryIcon.value = parent ? null : '' })
watch(categories, rows => { for (const row of rows) { if (!(row.id in categoryEdits.value)) categoryEdits.value[row.id] = row.name; if (!(row.id in categoryIconEdits.value)) categoryIconEdits.value[row.id] = row.icon } }, { flush: 'sync' })
const categoryIconMap = computed<CategoryIconMap>(() => ({ ...projectIcons.value, ...Object.fromEntries(categories.value.map(c => [c.slug,c.icon])) }))
const pendingBlockRestore = ref<number | null>(null), restoreCategory = ref(''), restoreSubcategory = ref('')
const project = ref<ProjectItem | null>(null)
const projectSettings = ref({ visibility: 'private' as 'public' | 'private', sync_repository: '', sync_branch: 'main' })
type SettingsHistory = { id: string; before: { visibility: string; sync_repository: string | null }; after: { visibility: string; sync_repository: string | null }; created_at: string; author: string | null }
const settingsHistoryPages = usePagedList<SettingsHistory>(path => api(path), () => `/projects/${project.value!.id}/settings/history/page`, item => item.id)
const projectSettingsHistory = settingsHistoryPages.items, settingsHistoryCursor = settingsHistoryPages.cursor, settingsHistoryLoading = settingsHistoryPages.loading
const projectSyncJobs = ref<any[]>([]), shareUrl = ref('')
const sharedProject = ref<ProjectItem | null>(null), shareError = ref('')
provide('imageUrl', (image: string) => sharedProject.value ? sharedImageUrl(image, new URLSearchParams(window.location.search).get('share')) : image)
const sharedNodes = ref<any[]>([]), sharedEdges = ref<any[]>([])
const diagram = ref<Diagram>({ name: '', nodes: [], edges: [] })
const flowNodes = ref<any[]>([]), flowEdges = ref<any[]>([])
const selectedNode = ref<string | null>(null), selectedEdge = ref<string | null>(null)
const panel = ref<'properties' | 'yaml' | 'history' | 'settings' | 'ai'>('properties')
const yamlDraft = ref(''), yamlDirty = ref(false), yamlError = ref(''), changeSummary = ref('')
const revisionPages = usePagedList<Revision>(path => api(path), () => `/projects/${project.value!.id}/revisions/page`, item => String(item.revision))
const revisions = revisionPages.items, revisionsCursor = revisionPages.cursor, revisionsLoading = revisionPages.loading
const diffText = ref(''), compareFrom = ref<number | null>(null), compareTo = ref<number | null>(null)
watch(() => project.value?.id, () => { projectIconGeneration++; projectIcons.value = {}; settingsHistoryPages.reset(); projectSyncJobs.value = []; revisionPages.reset(); diffText.value = ''; compareFrom.value = null; compareTo.value = null }, { flush: 'sync' })
let blockSelectionGeneration = 0
const blockSelection = ref<LibraryItem | null>(null), blockDraft = ref(''), blockSummary = ref('')
const blockVersionPages = usePagedList<Revision>(path => api(path), () => `/blocks/${blockSelection.value!.id}/versions/page`, item => String(item.version))
const blockVersions = blockVersionPages.items, blockVersionsCursor = blockVersionPages.cursor, blockVersionsLoading = blockVersionPages.loading
const blockCompareFrom = ref<number | null>(null), blockCompareTo = ref<number | null>(null), blockDiffText = ref('')
watch(() => blockSelection.value?.id, () => { blockVersionPages.reset(); blockDiffText.value = ''; blockCompareFrom.value = null; blockCompareTo.value = null }, { flush: 'sync' })
const newProjectName = ref(''), showNewProject = ref(false), showNewBlock = ref(false)
const imageScope = ref<'personal' | 'catalog'>('personal')
const newBlockScope = ref<'personal' | 'catalog'>('personal'), newCategoryScope = ref<'personal' | 'catalog'>('personal')
const createEmail = ref(''), createPassword = ref(''), createRole = ref<'view' | 'dev' | 'Admin'>('dev')
const currentPassword = ref(''), newPassword = ref('')
const importInput = ref<HTMLInputElement | null>(null)
const galleryInput = ref<HTMLInputElement | null>(null), galleryStorageVersion = ref(0)
const gallery = usePagedList<{ id: string; name: string; mime: string; scope: 'personal' | 'catalog'; owner_id: string | null; url: string; creator: string; created_at: string }>(path => api(path), '/images/page', item => item.id)
const galleryImages = gallery.items, galleryCursor = gallery.cursor, galleryLoading = gallery.loading
const { screenToFlowCoordinate, fitView } = useVueFlow()
watch([sidebarCollapsed, paletteCollapsed], () => { if (page.value === 'editor') setTimeout(() => fitView({ padding: 0.1, maxZoom: 1 }), 250) })
const lang = computed(() => user.value?.language || publicLanguage.value)
const t = (key: string) => (messages[lang.value] as Record<string, string>)[key] || key
const editable = computed(() => (user.value?.role === 'dev' || user.value?.role === 'Admin') && (page.value !== 'editor' || project.value?.permissions?.canEdit === true))
const admin = computed(() => user.value?.role === 'Admin')
const accountEditable = computed(() => user.value?.role === 'dev' || user.value?.role === 'Admin')
const libraryEditable = computed(() => editable.value && (showNewBlock.value || blockSelection.value?.permissions?.canEdit === true))
const categoryCreationRoots = computed(() => rootCategories.value.filter(c => (c.owner_id || null) === (newCategoryScope.value === 'catalog' ? null : user.value?.id)))
const blockCategoryRoots = computed(() => rootCategories.value.filter(c => !c.owner_id || c.owner_id === (showNewBlock.value ? (newBlockScope.value === 'personal' ? user.value?.id : null) : blockSelection.value?.owner_id)))
watch(newCategoryScope, () => { newCategoryParent.value = '' })
watch(() => user.value ? user.value.id + ':' + user.value.role : '', () => {
  newCategoryScope.value = user.value?.role === 'Admin' ? 'catalog' : 'personal'
  gallery.reset(); userPages.reset(); projectPages.reset(); blockPages.reset(); categoryContext.reset(); projectIconGeneration++; projectIcons.value = {}; blockSelectionGeneration++; settingsHistoryPages.reset(); projectSyncJobs.value = []; revisionPages.reset(); diffText.value = ''; compareFrom.value = null; compareTo.value = null; imageScope.value = 'personal'
  blockSelection.value = null; blockDraft.value = ''; blockVersionPages.reset(); blockDiffText.value = ''; showNewBlock.value = false
  newCategoryName.value = ''; newCategoryParent.value = ''; categoryEdits.value = {}; categoryIconEdits.value = {}
}, { flush: 'sync' })
const projectOwner = computed(() => !!project.value && (admin.value || project.value.created_by === user.value?.id))
const projectSettingsDirty = computed(() => !!project.value && (projectSettings.value.visibility !== project.value.visibility || projectSettings.value.sync_repository !== (project.value.sync_repository || '') || projectSettings.value.sync_branch !== (project.value.sync_branch || 'main')))
const selected = computed(() => diagram.value.nodes.find(n => n.id === selectedNode.value) || null)
const activeCategories = computed(() => categories.value.filter(category => !category.deleted_at))
const rootCategories = computed(() => activeCategories.value.filter(category => !category.parent_id))
const childCategories = (slug: string) => { const root = rootCategories.value.find(category => category.slug === slug); return root ? activeCategories.value.filter(category => category.parent_id === root.id) : [] }
const nodeLinkLabel = ref(''), nodeLinkUrl = ref(''), libraryLinkLabel = ref(''), libraryLinkUrl = ref('')

async function api(path: string, method = 'GET', body?: unknown, raw = false): Promise<any> {
  const res = await sessionRequest('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}))
    if (res.status === 429) throw new Error(t('rateLimitWait').replace('{seconds}', res.headers.get('Retry-After') || '60'))
    throw new Error(payload.error || (res.status === 409 ? t('conflict') : `HTTP ${res.status}`))
  }
  return raw ? res.text() : res.json()
}
async function run(fn: () => Promise<void>) {
  busy.value = true; errorMessage.value = ''; notice.value = ''
  try { await fn() } catch (e: unknown) { errorMessage.value = errorText(e) } finally { busy.value = false }
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
const actorKey = () => user.value ? user.value.id + ':' + user.value.role : ''
function blockCategorySlugs(yaml: string): string[] {
  try { const block = parseHardwareYaml(yaml); return [block?.category, block?.subcategory].filter(value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && new TextEncoder().encode(value).length <= 256) } catch { return [] }
}
async function resolveLoadedCategories(extra: string[] = []) {
  await categoryContext.ensure([...categoryContext.pages.items.value.map(row => row.slug), ...blocks.value.flatMap(row => blockCategorySlugs(row.yaml)), ...extra])
}
async function loadBasics() {
  const actor = actorKey(), retained = categories.value.find(row => row.id === newCategoryParent.value)?.slug
  const selectedSlugs = blockCategorySlugs(blockDraft.value)
  categoryContext.reset(); categoryEdits.value = {}; categoryIconEdits.value = {}
  await Promise.all([projectPages.first(), blockPages.first(), categoryContext.pages.first()])
  if (actor !== actorKey()) return
  await resolveLoadedCategories([...(retained ? [retained] : []), ...selectedSlugs])
  if (actor !== actorKey()) return
  if (!rootCategories.value.some(category => category.id === newCategoryParent.value)) newCategoryParent.value = ''
}
async function moreCategories() {
  if (busy.value || categoriesLoading.value) return
  const actor = actorKey(); errorMessage.value = ''
  try { await categoryContext.pages.more(); if (actor === actorKey()) await resolveLoadedCategories() } catch (e) { if (actor === actorKey()) errorMessage.value = errorText(e) }
}
async function moreBlocks() {
  if (busy.value || blocksLoading.value || categoriesLoading.value) return
  const actor = actorKey(); errorMessage.value = ''; notice.value = ''
  try { await blockPages.more(); if (actor === actorKey()) await resolveLoadedCategories() } catch (e) { if (actor === actorKey() && (page.value === 'library' || page.value === 'editor')) errorMessage.value = errorText(e) }
}
async function loadProjectIcons(id: string) {
  const actor = actorKey(), generation = ++projectIconGeneration, revision = project.value?.revision
  try { const icons = await api(`/projects/${id}/category-icons?baseRevision=${revision}`); if (generation === projectIconGeneration && actor === actorKey() && project.value?.id === id) projectIcons.value = icons }
  catch (e) { if (generation === projectIconGeneration && actor === actorKey() && project.value?.id === id) errorMessage.value = errorText(e) }
}
async function moreProjects() {
  if (busy.value || projectsLoading.value) return
  errorMessage.value = ''; notice.value = ''
  try { await projectPages.more() } catch (e) { if (page.value === 'projects') errorMessage.value = errorText(e) }
}
async function acceptSignIn(value: User) { user.value = value; mfaChallenge.value = undefined; loginPassword.value = ''; await loadBasics(); page.value = 'projects' }
async function completeMfaSignIn(value: User) { await run(() => acceptSignIn(value)) }
async function signIn() {
  await run(async () => {
    const result = await api('/login', 'POST', { email: loginEmail.value, password: loginPassword.value })
    loginPassword.value = ''
    if (result.mfaRequired) { mfaChallenge.value = result; return }
    await acceptSignIn(result)
  })
}
function endSession() { mfaChallenge.value = undefined; user.value = null; project.value = null; projectPages.reset(); blockPages.reset(); categoryContext.reset(); gallery.reset(); userPages.reset(); page.value = 'projects'; loginPassword.value = ''; currentPassword.value = ''; newPassword.value = ''; createPassword.value = ''; createEmail.value = '' }
function handleSessionExpired() { if (user.value) expireSession() }
function expireSession() { const message = t('sessionExpired'); endSession(); notice.value = message }
async function signOut() { await run(async () => { await api('/logout', 'POST'); endSession() }) }
async function updatePreference(field: 'language' | 'theme', value: string) { if (!user.value) return; await run(async () => { await api('/me', 'PATCH', { [field]: value }); if (user.value) user.value = { ...user.value, [field]: value } as User }) }
async function changeOwnPassword() { await run(async () => { await api('/me/password', 'POST', { currentPassword: currentPassword.value, newPassword: newPassword.value }); const message = t('passwordChangedSignIn'); currentPassword.value = ''; newPassword.value = ''; endSession(); notice.value = message }) }

function graphFromDiagram() {
  flowNodes.value = diagram.value.nodes.map(n => ({ id: n.id, type: 'hardware', position: { ...n.position }, data: { block: n.block, libraryVersion: n.libraryVersion } }))
  flowEdges.value = diagram.value.edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourcePort, targetHandle: e.targetPort, type: 'routed', animated: false, label: findProtocol(e), data: { route: e.route, editable: editable.value, labelColor: edgeLabelColor(), color: findEdgeColor(e), bidirectional: isBidirectionalEdge(e) } }))
  setTimeout(() => fitView({ padding: 0.1, maxZoom: 1 }), 50)
}
function edgeLabelColor() { return (user.value?.theme || 'light') === 'light' ? '#28241f' : '#f2ece5' }
function safePortColor(value?: string) { return safeHexColor(value) }
function findEdgeColor(e: Diagram['edges'][number], doc: Diagram = diagram.value) { const source = doc.nodes.find(n => n.id === e.source)?.block.ports.find(p => p.id === e.sourcePort); const target = doc.nodes.find(n => n.id === e.target)?.block.ports.find(p => p.id === e.targetPort); return safePortColor(source?.color) || safePortColor(target?.color) || ((user.value?.theme || 'light') === 'light' ? '#c95016' : '#f28b45') }
function isBidirectionalEdge(e: Diagram['edges'][number], doc: Diagram = diagram.value) { return bothPortsBidirectional(e, doc) }
watch(() => user.value?.theme, () => { for (const edge of flowEdges.value) { const saved = diagram.value.edges.find(e => e.id === edge.id); if (saved && edge.data) Object.assign(edge.data, { color: findEdgeColor(saved), labelColor: edgeLabelColor() }) } })
function findProtocol(e: Diagram['edges'][number]) { return diagram.value.nodes.find(n => n.id === e.source)?.block.ports.find(p => p.id === e.sourcePort)?.protocol || '' }
function parseHardwareYaml(text: string) { return YAML.parse(text.replace(/^([ \t]*color:[ \t]*)(#[0-9a-fA-F]{6})(?=[ \t]*(?:#.*)?\r?$)/gm, '$1"$2"')) }
function safeExternalUrl(value: unknown) { if (typeof value !== 'string' || value.length > 2048) return ''; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' } }
function formatProperty(value: unknown) { return typeof value === 'string' ? value : value == null ? '—' : JSON.stringify(value) }
function propertyLinks(properties?: Record<string, unknown>) {
  const links: { index: number; label: string; url: string }[] = []
  if (typeof properties?.url === 'string') links.push({ index: -1, label: 'datasheet', url: properties.url })
  if (Array.isArray(properties?.urls)) properties.urls.forEach((entry, index) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const [label, url] = Object.entries(entry)[0] || []
      if (label && typeof url === 'string') links.push({ index, label, url })
    }
  })
  return links
}
function libraryProperties(yaml: string): Record<string, unknown> { try { return (parseHardwareYaml(yaml) as Block)?.properties || {} } catch { return {} } }
function libraryColor(yaml: string) { try { return safeHexColor((parseHardwareYaml(yaml) as Block)?.color) } catch { return undefined } }
function editPropertiesLink(properties: Record<string, unknown> | undefined, index: number, label: string, url: string, remove = false) {
  const next = { ...properties }
  const links = Array.isArray(next.urls) ? [...next.urls] : []
  if (!remove && (!label.trim() || label.trim().length > 100 || !safeExternalUrl(url.trim()))) throw new Error(t('invalidPropertyLink'))
  if (index === -1) {
    delete next.url
    if (!remove) links.unshift({ [label.trim()]: url.trim() })
  } else if (remove) links.splice(index, 1)
  else if (index >= links.length) links.push({ [label.trim()]: url.trim() })
  else links[index] = { [label.trim()]: url.trim() }
  if (links.length) next.urls = links
  else delete next.urls
  return next
}
function safeImage(value?: string) { return typeof value === 'string' && (value.startsWith('https://') || /^\/api\/images\/[0-9a-f-]{36}\/content$/.test(value)) ? value : '' }
function imageFromYaml(yaml: string) { try { return safeImage((parseHardwareYaml(yaml) as Block)?.image) } catch { return '' } }
function applyBlockImage(value: string) { const parsed = parseHardwareYaml(blockDraft.value) as Block; if (!parsed || typeof parsed !== 'object') throw new Error(t('invalid')); parsed.image = value; blockDraft.value = YAML.stringify(parsed, { lineWidth: 0 }) }
async function setBlockImage(value: string) { await run(async () => applyBlockImage(value)) }
function applyBlockColor(value: string) { const parsed = parseHardwareYaml(blockDraft.value) as Block; if (!parsed || typeof parsed !== 'object') throw new Error(t('invalid')); if (value && !safeHexColor(value)) throw new Error(t('invalidBlockColor')); if (value) parsed.color = value; else delete parsed.color; blockDraft.value = YAML.stringify(parsed, { lineWidth: 0 }) }
async function setBlockColor(value: string) { await run(async () => applyBlockColor(value)) }
function applyBlockNotes(value: string) { const parsed = parseHardwareYaml(blockDraft.value) as Block; if (!parsed || typeof parsed !== 'object') throw new Error(t('invalid')); parsed.properties = { ...(parsed.properties || {}), notes: value }; blockDraft.value = YAML.stringify(parsed, { lineWidth: 0 }) }
async function setBlockNotes(value: string) { await run(async () => applyBlockNotes(value)) }
async function openGallery() { const owner = user.value?.id; await run(async () => { await gallery.first(); if (user.value?.id === owner) page.value = 'gallery' }) }
async function moreGallery() {
  if (busy.value || galleryLoading.value) return
  errorMessage.value = ''; notice.value = ''
  try { await gallery.more() } catch (e) { if (page.value === 'gallery') errorMessage.value = errorText(e) }
}
async function uploadGalleryImage(file?: File) {
  if (!file) return
  await run(async () => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1_000_000) throw new Error(t('imageLimit'))
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(new Error(t('imageLimit'))); reader.readAsDataURL(file) })
    await api('/images', 'POST', { name: file.name, mime: file.type, scope: imageScope.value, data })
    await gallery.first(); galleryStorageVersion.value++; notice.value = t('imageUploaded')
  })
  if (galleryInput.value) galleryInput.value.value = ''
}
async function copyImageUrl(url: string) { try { await navigator.clipboard.writeText(url); notice.value = t('imageCopied') } catch { notice.value = t('copyImageHint') } }
async function deleteGalleryImage(id: string) { if (!accountEditable.value || !confirm(t('deleteImageConfirm'))) return; await run(async () => { await api('/images/' + id, 'DELETE'); await gallery.first(); galleryStorageVersion.value++ }) }
function syncFromGraph() {
  if (!project.value) return
  const positions = new Map(flowNodes.value.map(n => [n.id, n.position]))
  diagram.value.nodes = diagram.value.nodes.filter(n => positions.has(n.id)).map(n => ({ ...n, position: positions.get(n.id) || n.position }))
  diagram.value.edges = flowEdges.value.map(e => ({ id: e.id, source: e.source, target: e.target, sourcePort: e.sourceHandle, targetPort: e.targetHandle, ...(e.data?.route ? { route: e.data.route } : {}) }))
  if (!yamlDirty.value) yamlDraft.value = YAML.stringify(diagram.value, { lineWidth: 0 })
}
watch(flowNodes, syncFromGraph, { deep: true })
watch(flowEdges, syncFromGraph, { deep: true })
// Keep selected route handles reachable when a leg runs along a block.
watch(selectedEdge, id => { for (const edge of flowEdges.value) edge.zIndex = edge.id === id ? 1001 : 0 })
async function openProject(id: string) { await run(async () => {
  await loadBasics()
  project.value = await api('/projects/' + id)
  projectSettings.value = { visibility: project.value!.visibility, sync_repository: project.value!.sync_repository || '', sync_branch: project.value!.sync_branch || 'main' }
  shareUrl.value = ''
  diagram.value = parseHardwareYaml(project.value!.yaml || '') as Diagram
  yamlDraft.value = project.value!.yaml || ''; yamlDirty.value = false; yamlError.value = ''; selectedNode.value = null; selectedEdge.value = null; panel.value = 'properties'; page.value = 'editor'; graphFromDiagram(); await Promise.all([loadRevisions(), loadProjectIcons(id)])
}) }
async function openProjectWithSettings(id: string) { await openProject(id); if (project.value?.id === id) await openProjectSettings() }
async function openProjectSettings() { if (!project.value) return; const id = project.value.id, actor = user.value?.id + ':' + user.value?.role; panel.value = 'settings'; await run(async () => { const [, jobs] = await Promise.all([settingsHistoryPages.first(), api(`/projects/${id}/sync`)]); if (project.value?.id === id && actor === user.value?.id + ':' + user.value?.role) projectSyncJobs.value = jobs }); if (window.innerWidth < 1200) { await nextTick(); document.querySelector('.inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }
async function moreSettingsHistory() {
  if (!project.value || busy.value || settingsHistoryLoading.value) return
  errorMessage.value = ''
  try { await settingsHistoryPages.more() } catch (e) { if (page.value === 'editor' && panel.value === 'settings') errorMessage.value = errorText(e) }
}
async function saveProjectSettings() { if (!project.value || !projectOwner.value) return; await run(async () => {
  project.value = await api(`/projects/${project.value!.id}/settings`, 'PATCH', { ...projectSettings.value, expectedSettingsVersion: project.value!.settings_version })
  projectSettings.value = { visibility: project.value!.visibility, sync_repository: project.value!.sync_repository || '', sync_branch: project.value!.sync_branch || 'main' }
  shareUrl.value = ''; await loadBasics(); await settingsHistoryPages.first(); projectSyncJobs.value = await api(`/projects/${project.value!.id}/sync`); notice.value = t('saved')
}) }
async function shareProject() { if (!project.value || projectSettingsDirty.value) return; await run(async () => {
  const path = project.value!.visibility === 'public' ? `/?public=${project.value!.id}` : (await api(`/projects/${project.value!.id}/share`, 'POST')).path
  shareUrl.value = new URL(path, window.location.origin).href
  try { await navigator.clipboard.writeText(shareUrl.value); notice.value = t('linkCopied') } catch { notice.value = t('copyLink') }
}) }
async function revokeShare() { if (!project.value || !projectOwner.value) return; await run(async () => { await api(`/projects/${project.value!.id}/share`, 'DELETE'); shareUrl.value = ''; notice.value = t('linkRevoked') }) }
async function retryProjectSync() { if (!project.value || !projectOwner.value) return; await run(async () => { await api(`/projects/${project.value!.id}/sync/retry`, 'POST'); projectSyncJobs.value = await api(`/projects/${project.value!.id}/sync`) }) }
async function loadSharedProject() {
  const params = new URLSearchParams(window.location.search)
  const path = params.get('share') ? `/shared/${encodeURIComponent(params.get('share')!)}` : params.get('public') ? `/public/projects/${encodeURIComponent(params.get('public')!)}` : ''
  if (!path) return false
  try {
    sharedProject.value = await api(path)
    const doc = parseHardwareYaml(sharedProject.value!.yaml || '') as Diagram
    sharedNodes.value = doc.nodes.map(n => ({ id: n.id, type: 'hardware', position: n.position, data: { block: n.block } }))
    sharedEdges.value = doc.edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourcePort, targetHandle: e.targetPort, type: 'routed', label: doc.nodes.find(n => n.id === e.source)?.block.ports.find(p => p.id === e.sourcePort)?.protocol || '', data: { route: e.route, editable: false, labelColor: edgeLabelColor(), color: findEdgeColor(e, doc), bidirectional: isBidirectionalEdge(e, doc) } }))
  } catch (e) { shareError.value = errorText(e) }
  return true
}
async function createProject() { await run(async () => { const yaml = YAML.stringify({ name: newProjectName.value.trim() || t('newProject'), nodes: [], edges: [] }); const made = await api('/projects', 'POST', { yaml }); showNewProject.value = false; newProjectName.value = ''; await loadBasics(); await openProject(made.id) }) }
async function importProject(file?: File) { if (!file) return; await run(async () => { const yaml = await file.text(); await api('/validate', 'POST', { kind: 'project', yaml }); const made = await api('/projects', 'POST', { yaml, summary: 'Imported YAML' }); await loadBasics(); await openProject(made.id) }) }
async function saveProject() { if (!project.value || !editable.value) return; await run(async () => {
  if (yamlDirty.value) throw new Error(t('invalid'))
  syncFromGraph()
  const yaml = YAML.stringify(diagram.value, { lineWidth: 0 })
  await api('/validate', 'POST', { kind: 'project', yaml })
  const saved = await api('/projects/' + project.value!.id, 'PUT', { yaml, expectedRevision: project.value!.revision, summary: changeSummary.value.trim() || undefined })
  project.value!.revision = saved.revision; project.value!.yaml = yaml; yamlDraft.value = yaml; changeSummary.value = ''; notice.value = t('saved'); await loadRevisions(); await loadBasics()
}) }
async function applyYaml() { await run(async () => {
  await api('/validate', 'POST', { kind: 'project', yaml: yamlDraft.value })
  const next = parseHardwareYaml(yamlDraft.value) as Diagram
  await categoryContext.ensure(next.nodes.flatMap(node => [node.block.category, node.block.subcategory].filter((slug): slug is string => !!slug)))
  diagram.value = next
  yamlDirty.value = false; yamlError.value = ''; graphFromDiagram()
}) }
function onYamlInput() { yamlDirty.value = true; yamlError.value = '' }
function makeNode(item: LibraryItem, position?: { x: number; y: number }) {
  if (!editable.value) return
  const block = parseHardwareYaml(item.yaml) as Block
  const node: DiagramNode = { id: crypto.randomUUID(), position: position || { x: 60 + (diagram.value.nodes.length % 3) * 250, y: 80 + Math.floor(diagram.value.nodes.length / 3) * 220 }, block, libraryId: item.id, libraryVersion: item.latest_version }
  diagram.value.nodes.push(node)
  flowNodes.value = [...flowNodes.value, { id: node.id, type: 'hardware', position: node.position, data: { block: node.block, libraryVersion: node.libraryVersion } }]
  selectedNode.value = node.id; panel.value = 'properties'; syncFromGraph()
  setTimeout(() => fitView({ padding: 0.1, maxZoom: 1 }), 50)
}
function dragStart(event: DragEvent, item: LibraryItem) { if (editable.value) event.dataTransfer?.setData('application/hardware-block', item.id) }
function dropBlock(event: DragEvent) { event.preventDefault(); const id = event.dataTransfer?.getData('application/hardware-block'); const item = blocks.value.find(b => b.id === id); if (item) makeNode(item, screenToFlowCoordinate({ x: event.clientX, y: event.clientY })) }
async function connect(edge: Connection) {
  if (!editable.value || !edge.source || !edge.target || !edge.sourceHandle || !edge.targetHandle) return
  const candidate = { id: crypto.randomUUID(), source: edge.source, target: edge.target, sourcePort: edge.sourceHandle, targetPort: edge.targetHandle }
  const next = { ...diagram.value, edges: [...diagram.value.edges, candidate] }
  await run(async () => { await api('/validate', 'POST', { kind: 'project', yaml: YAML.stringify(next) }); diagram.value.edges.push(candidate); flowEdges.value.push({ id: candidate.id, source: candidate.source, target: candidate.target, sourceHandle: candidate.sourcePort, targetHandle: candidate.targetPort, type: 'routed', label: findProtocol(candidate), data: { editable: editable.value, labelColor: edgeLabelColor(), color: findEdgeColor(candidate), bidirectional: isBidirectionalEdge(candidate) } }); selectedEdge.value = candidate.id; selectedNode.value = null })
}
function removeNode() { if (!editable.value || !selectedNode.value) return; const id = selectedNode.value; diagram.value.nodes = diagram.value.nodes.filter(n => n.id !== id); flowNodes.value = flowNodes.value.filter(n => n.id !== id); flowEdges.value = flowEdges.value.filter(e => e.source !== id && e.target !== id); selectedNode.value = null; syncFromGraph() }
function resetEdgeRoute() { if (!editable.value || !selectedEdge.value) return; const edge = flowEdges.value.find(e => e.id === selectedEdge.value); if (edge?.data) { edge.data.route = undefined; syncFromGraph() } }
function removeEdge() { if (!editable.value || !selectedEdge.value) return; flowEdges.value = flowEdges.value.filter(e => e.id !== selectedEdge.value); selectedEdge.value = null; syncFromGraph() }
function updateNodeLink(index: number, label: string, url: string, remove = false) {
  if (!selected.value || !editable.value) return
  selected.value.block.properties = editPropertiesLink(selected.value.block.properties, index, label, url, remove)
  const node = flowNodes.value.find(n => n.id === selectedNode.value)
  if (node) node.data.block = { ...selected.value.block }
  syncFromGraph()
}
async function applyNodeLink(index: number, label: string, url: string, remove = false) { await run(async () => { updateNodeLink(index, label, url, remove); if (index >= propertyLinks(selected.value?.block.properties).length && !remove) { nodeLinkLabel.value = ''; nodeLinkUrl.value = '' } }) }
function setBlockLink(index: number, label: string, url: string, remove = false) {
  const block = parseHardwareYaml(blockDraft.value) as Block
  if (!block || typeof block !== 'object') throw new Error(t('invalid'))
  block.properties = editPropertiesLink(block.properties, index, label, url, remove)
  blockDraft.value = YAML.stringify(block, { lineWidth: 0 })
}
async function applyBlockLink(index: number, label: string, url: string, remove = false) { await run(async () => { setBlockLink(index, label, url, remove); if (index >= propertyLinks(libraryProperties(blockDraft.value)).length && !remove) { libraryLinkLabel.value = ''; libraryLinkUrl.value = '' } }) }
function updateNodeField(field: 'name' | 'function' | 'model' | 'image', value: string) { if (!selected.value || !editable.value) return; selected.value.block[field] = value; const n = flowNodes.value.find(x => x.id === selectedNode.value); if (n) n.data.block = { ...selected.value.block }; syncFromGraph() }
async function setNodeColor(value: string) { await run(async () => { if (!editable.value || !selected.value) return; if (value && !safeHexColor(value)) throw new Error(t('invalidBlockColor')); if (value) selected.value.block.color = value; else delete selected.value.block.color; const node = flowNodes.value.find(n => n.id === selectedNode.value); if (node) node.data.block = { ...selected.value.block }; syncFromGraph() }) }
function setNodeNotes(value: string) { if (!editable.value || !selected.value) return; selected.value.block.properties = { ...(selected.value.block.properties || {}), notes: value }; const node = flowNodes.value.find(n => n.id === selectedNode.value); if (node) node.data.block = { ...selected.value.block }; syncFromGraph() }
async function updateNodeToLatest() { if (!selected.value?.libraryId || !editable.value) return; const node = selected.value, owner = project.value?.id; await run(async () => { const item = await api(`/blocks/${node.libraryId}`); if (project.value?.id !== owner || selected.value !== node || !editable.value) return; node.block = parseHardwareYaml(item.yaml); node.libraryVersion = item.latest_version; graphFromDiagram() }) }

async function loadRevisions() {
  if (!project.value) return
  diffText.value = ''; compareFrom.value = null; compareTo.value = null
  try { await revisionPages.first() } catch (e) { if (page.value === 'editor') errorMessage.value = errorText(e) }
}
async function moreRevisions() {
  if (!project.value || busy.value || revisionsLoading.value) return
  errorMessage.value = ''
  try { await revisionPages.more() } catch (e) { if (page.value === 'editor') errorMessage.value = errorText(e) }
}
async function compareRevisions() { if (!project.value || compareFrom.value == null || compareTo.value == null) return; await run(async () => { diffText.value = await api(`/projects/${project.value!.id}/diff?from=${compareFrom.value}&to=${compareTo.value}`, 'GET', undefined, true) }) }
async function restoreRevision(revision: number) { if (!project.value || !editable.value) return; await run(async () => { await api(`/projects/${project.value!.id}/restore`, 'POST', { revision, expectedRevision: project.value!.revision }); await openProject(project.value!.id) }) }
async function deleteProject(id: string) { if (!accountEditable.value || !confirm(t('moveToTrashConfirm'))) return; await run(async () => { await api(`/projects/${id}`, 'DELETE'); if (project.value?.id === id) { project.value = null; page.value = 'projects' }; await loadBasics() }) }
function download(name: string, data: string, mime: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000) }
function exportYaml() { if (project.value) download(`${project.value.name}.yaml`, YAML.stringify(diagram.value, { lineWidth: 0 }), 'text/yaml') }
async function exportImage(format: 'svg' | 'png') {
  const element = document.querySelector('.canvas .vue-flow') as HTMLElement
  if (!element || !project.value) return
  await run(async () => {
    const backgroundColor = getComputedStyle(element.closest('.canvas')!).getPropertyValue('--bg').trim()
    const frame = createExportFrame(element)
    try {
      // Reset logical insets too: computed inset-inline can retain the offscreen offset.
      const options = { backgroundColor, style: { position: 'relative', inset: 'auto', insetInline: 'auto', insetBlock: 'auto', left: '0', top: '0' } }
      const data = format === 'svg' ? await toSvg(frame, options) : await toPng(frame, { ...options, pixelRatio: 2 })
      const a = document.createElement('a')
      a.href = data
      a.download = `${project.value!.name}.${format}`
      a.hidden = true
      document.body.append(a)
      try { a.click() } finally { setTimeout(() => a.remove(), 1000) }
    } finally { frame.remove() }
  })
}

async function openLibrary() { await run(async () => { await loadBasics(); page.value = 'library'; if (blockSelection.value) await selectBlock(blockSelection.value.id) }) }
async function loadBlockVersions() {
  if (!blockSelection.value) return
  blockDiffText.value = ''; blockCompareFrom.value = null; blockCompareTo.value = null
  try { await blockVersionPages.first() } catch (e) { if (page.value === 'library') errorMessage.value = errorText(e) }
}
async function moreBlockVersions() {
  if (!blockSelection.value || busy.value || blockVersionsLoading.value) return
  errorMessage.value = ''
  try { await blockVersionPages.more() } catch (e) { if (page.value === 'library') errorMessage.value = errorText(e) }
}
async function selectBlock(id: string) {
  const generation = ++blockSelectionGeneration
  showNewBlock.value = false; pendingBlockRestore.value = null; blockSelection.value = null; blockDraft.value = ''; errorMessage.value = ''
  try {
    const item = await api(`/blocks/${id}`)
    if (generation !== blockSelectionGeneration) return
    await categoryContext.ensure(blockCategorySlugs(item.yaml))
    if (generation !== blockSelectionGeneration) return
    blockSelection.value = item; blockDraft.value = item.yaml; await loadBlockVersions()
  } catch (e) { if (generation === blockSelectionGeneration && page.value === 'library') errorMessage.value = errorText(e) }
}
function blockDraftCategory() { try { return (parseHardwareYaml(blockDraft.value) as Block)?.category || '' } catch { return '' } }
function blockDraftSubcategory() { try { return (parseHardwareYaml(blockDraft.value) as Block)?.subcategory || '' } catch { return '' } }
function setBlockCategory(category: string, subcategory = '') { const block = parseHardwareYaml(blockDraft.value) as Block; if (!block || typeof block !== 'object') throw new Error(t('invalid')); if (category) block.category = category; else delete block.category; if (subcategory) block.subcategory = subcategory; else delete block.subcategory; blockDraft.value = YAML.stringify(block, { lineWidth: 0 }) }
async function applyBlockCategory(category: string, subcategory = '') { await run(async () => setBlockCategory(category, subcategory)) }
function copyLibraryBlock() { if (!editable.value || !blockSelection.value) return; const yaml = blockDraft.value; newBlock(); newBlockScope.value = 'personal'; blockDraft.value = yaml }
function newBlock() { blockSelectionGeneration++; newBlockScope.value = admin.value ? 'catalog' : 'personal'; blockSelection.value = null; showNewBlock.value = true; blockDraft.value = YAML.stringify({ name: lang.value === 'es' ? 'Nuevo bloque' : 'New block', function: '', model: '', properties: {}, ports: [{ id: 'i2c', label: 'I²C', protocol: 'I2C', direction: 'bidirectional', maxConnections: 1 }] }); blockVersionPages.reset() }
async function saveBlock() { if (!libraryEditable.value) return; await run(async () => { const yaml = YAML.stringify(parseHardwareYaml(blockDraft.value), { lineWidth: 0 }); await api('/validate', 'POST', { kind: 'block', yaml, scope: newBlockScope.value, blockId: blockSelection.value?.id }); const id = blockSelection.value?.id || (await api('/blocks', 'POST', { yaml, scope: newBlockScope.value, summary: blockSummary.value.trim() || undefined })).id; if (blockSelection.value) await api(`/blocks/${id}`, 'PUT', { yaml, expectedVersion: blockSelection.value.latest_version, summary: blockSummary.value.trim() || undefined }); showNewBlock.value = false; blockSummary.value = ''; await loadBasics(); await selectBlock(id); notice.value = t('saved') }) }
async function createCatalogCategory() { await run(async () => { const made = await api('/categories', 'POST', { name: newCategoryName.value, parentId: newCategoryParent.value || null, icon: newCategoryIcon.value, scope: newCategoryScope.value }); newCategoryName.value = ''; newCategoryIcon.value = newCategoryParent.value ? null : ''; await loadBasics(); await categoryContext.ensure([made.slug]); notice.value = t('saved') }) }
async function renameCatalogCategory(category: Category) { await run(async () => { await api(`/categories/${category.id}`, 'PATCH', { name: categoryEdits.value[category.id], icon: categoryIconEdits.value[category.id] }); await loadBasics(); notice.value = t('saved') }) }
async function deleteCatalogCategory(category: Category) { if (!confirm(t('deleteConfirm'))) return; await run(async () => { await api(`/categories/${category.id}`, 'DELETE'); await loadBasics(); notice.value = t('saved') }) }
async function deleteBlock() { if (!libraryEditable.value || !blockSelection.value || !confirm(t('moveToTrashConfirm'))) return; await run(async () => { await api(`/blocks/${blockSelection.value!.id}`, 'DELETE'); blockSelection.value = null; blockDraft.value = ''; await loadBasics() }) }
async function viewBlockVersion(version: number) { if (!blockSelection.value) return; await run(async () => { blockDraft.value = await api(`/blocks/${blockSelection.value!.id}/versions/${version}`, 'GET', undefined, true); await categoryContext.ensure(blockCategorySlugs(blockDraft.value)) }) }
async function compareBlockVersions() { if (!blockSelection.value || blockCompareFrom.value == null || blockCompareTo.value == null) return; await run(async () => { blockDiffText.value = await api(`/blocks/${blockSelection.value!.id}/diff?from=${blockCompareFrom.value}&to=${blockCompareTo.value}`, 'GET', undefined, true) }) }
async function restoreBlockVersion(version: number) { if (!blockSelection.value || !editable.value) return; await run(async () => { const yaml = await api(`/blocks/${blockSelection.value!.id}/versions/${version}`, 'GET', undefined, true); const old = parseHardwareYaml(yaml) as Block; await categoryContext.ensure(blockCategorySlugs(yaml)); const root = rootCategories.value.find(category => category.slug === old.category); const child = old.subcategory ? childCategories(old.category || '').find(category => category.slug === old.subcategory) : null; if (old.category && (!root || (old.subcategory && !child))) { pendingBlockRestore.value = version; restoreCategory.value = root?.slug || ''; restoreSubcategory.value = ''; return } await commitBlockRestore(version) }) }
async function commitBlockRestore(version: number, remap = false) { if (!blockSelection.value) return; const id = blockSelection.value.id; await api(`/blocks/${id}/restore`, 'POST', { version, expectedVersion: blockSelection.value.latest_version, ...(remap ? { category: restoreCategory.value, subcategory: restoreSubcategory.value } : {}) }); pendingBlockRestore.value = null; await loadBasics(); await selectBlock(id); notice.value = t('saved') }
async function confirmBlockRestore() { if (pendingBlockRestore.value == null || !restoreCategory.value) return; await run(() => commitBlockRestore(pendingBlockRestore.value!, true)) }

async function manageUsers(action?: () => Promise<void>) {
  if (!admin.value || busy.value || usersLoading.value) return
  const actor = actorKey(); busy.value = true; errorMessage.value = ''; notice.value = ''
  try { if (action) await action(); if (actor === actorKey()) await userPages.first() }
  catch(e) { if (actor === actorKey()) errorMessage.value = errorText(e) }
  finally { if (actor === actorKey()) busy.value = false }
}
async function openUsers() { if (!admin.value) return; page.value = 'users'; await manageUsers() }
async function moreUsers() {
  if (!admin.value || busy.value || usersLoading.value) return
  const actor = actorKey(); errorMessage.value = ''
  try { await userPages.more() } catch(e) { if (actor === actorKey()) errorMessage.value = errorText(e) }
}
async function createUser() { const actor = actorKey(); await manageUsers(async () => { await api('/users', 'POST', { email: createEmail.value, password: createPassword.value, role: createRole.value }); if (actor === actorKey()) { createEmail.value = ''; createPassword.value = '' } }) }
async function setRole(id: string, role: string) { await manageUsers(async () => { await api(`/users/${id}`, 'PATCH', { role }) }) }
async function deleteUser(id: string) { if (!admin.value || !confirm(t('deleteConfirm'))) return; await manageUsers(async () => { await api(`/users/${id}`, 'DELETE') }) }
async function openAi() { panel.value = 'ai'; if (window.innerWidth < 1200) { await nextTick(); document.querySelector('.inspector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }
function selectAiNode(id: string) { selectedNode.value = id; selectedEdge.value = null; fitView({ nodes: [id], padding: 0.5, maxZoom: 1 }) }
function openSettings() { page.value = 'settings' }

onUnmounted(() => window.removeEventListener('sugar:session-expired', handleSessionExpired))
function closeRegistration(complete = false) { verificationToken.value = ''; registrationOpen.value = false; notice.value = complete ? t('registrationComplete') : ''; errorMessage.value = '' }
function closeRecovery(kind?: 'reset' | 'email_change') { accountAction.value = null; recoveryOpen.value = false; notice.value = kind ? t(kind === 'reset' ? 'recoveryComplete' : 'emailChangeComplete') : ''; errorMessage.value = '' }
onMounted(async () => {
  window.addEventListener('sugar:session-expired', handleSessionExpired)
  try { registrationEnabled.value = (await api('/registration')).enabled } catch { registrationEnabled.value = false }
  try { recoveryEnabled.value = (await api('/recovery')).enabled } catch { recoveryEnabled.value = false }
  if (accountAction.value) { recoveryOpen.value = true; return }
  if (verificationToken.value) { registrationOpen.value = true; return }
  if (await loadSharedProject()) return
  try { user.value = await api('/me'); await loadBasics() } catch { user.value = null }
})
</script>

<template>
  <div class="app-shell" :class="user?.theme || 'light'">
    <div v-if="sharedProject || shareError" class="shared-screen">
      <header class="shared-header"><div><div class="brand-lockup shared-brand"><img src="/sugar-mark.png" alt="" width="32" height="32"><span>Sugar</span></div><div class="eyebrow">{{ t('sharedProject') }}</div><h1>{{ sharedProject?.name || t('linkUnavailable') }}</h1><p v-if="sharedProject">{{ t('creator') }}: {{ sharedProject.creator || t('unknownCreator') }} · {{ t('revision') }} {{ sharedProject.revision }} · {{ sharedProject.visibility === 'public' ? t('public') : t('private') }}</p><p v-else>{{ shareError }}</p></div><div class="header-actions"><button v-if="sharedProject" class="secondary" @click="download(`${sharedProject.name}.yaml`, sharedProject.yaml || '', 'text/yaml')">↓ YAML</button><a class="secondary" href="/">{{ t('openApp') }}</a></div></header>
      <div v-if="sharedProject" class="shared-canvas"><VueFlow :nodes="sharedNodes" :edges="sharedEdges" :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="false" fit-view-on-init><Background pattern-color="#8b95a8" :gap="20" :size="1" /><Controls /><template #edge-routed="edgeProps"><RoutedEdge v-bind="edgeProps" /></template><template #node-hardware="{ data }"><div class="hardware-node"><div class="node-header" :class="{ 'has-custom-color': !!safeHexColor(data.block.color) }" :style="headerStyle(data.block.color)"><span class="node-symbol"><BlockSymbol :block="data.block" :icons="sharedProject.category_icons || {}" class="icon-node" /></span><strong>{{ data.block.name }}</strong></div><div class="node-model">{{ data.block.model || data.block.function }}</div><div v-for="port in data.block.ports" :key="port.id" class="node-port"><Handle v-if="port.direction !== 'out'" :id="port.id" type="target" :position="Position.Left" :style="safePortColor(port.color) ? { backgroundColor: port.color } : undefined" /><span>{{ port.label }}</span><em>{{ port.protocol }}</em><Handle v-if="port.direction !== 'in'" :id="port.id" type="source" :position="Position.Right" :style="safePortColor(port.color) ? { backgroundColor: port.color } : undefined" /></div></div></template></VueFlow><div v-if="!sharedNodes.length" class="canvas-hint"><CpuChipIcon class="ui-icon icon-empty" aria-hidden="true" /><p>{{ t('noBlocks') }}</p></div></div>
    </div>
    <div v-else-if="!user" class="login-screen">
      <div class="login-card"><div class="brand-lockup login-brand"><img src="/sugar-mark.png" alt="" width="40" height="40"><span>Sugar</span></div><div class="eyebrow">SYSTEM ARCHITECTURE</div><div class="segmented"><button :class="{active:publicLanguage==='es'}" @click="publicLanguage='es'">Español</button><button :class="{active:publicLanguage==='en'}" @click="publicLanguage='en'">English</button></div>
        <MfaLoginForm v-if="mfaChallenge" :language="publicLanguage" :challenge="mfaChallenge" @complete="completeMfaSignIn" @cancel="mfaChallenge=undefined; errorMessage=''; notice=''" />
        <AccountRecoveryForm v-else-if="recoveryOpen" :language="publicLanguage" :kind="accountAction?.kind || 'request'" :token="accountAction?.token || ''" :enabled="recoveryEnabled" @cancel="closeRecovery()" @complete="closeRecovery" />
        <RegistrationForm v-else-if="registrationOpen" :language="publicLanguage" :token="verificationToken" :enabled="registrationEnabled" @cancel="closeRegistration()" @complete="closeRegistration(true)" />
        <template v-else><h1>{{ t('welcome') }}</h1><p>{{ t('welcomeSub') }}</p><form @submit.prevent="signIn"><label>{{ t('email') }}<input v-model="loginEmail" type="email" autocomplete="username" required></label><label>{{ t('password') }}<input v-model="loginPassword" type="password" autocomplete="current-password" required></label><button class="primary wide" :disabled="busy">{{ t('signIn') }}</button></form><button v-if="recoveryEnabled" class="link-button" @click="recoveryOpen=true; notice=''; errorMessage=''">{{ t('forgotPassword') }}</button><button v-if="registrationEnabled" class="link-button" @click="registrationOpen=true; notice=''; errorMessage=''">{{ t('createAccount') }}</button></template>
        <p v-if="notice" role="status">{{ notice }}</p><div v-if="errorMessage" class="message error">{{ errorMessage }}</div>
      </div>
    </div>
    <template v-else>
      <header class="sugar-topbar"><button class="brand-lockup" aria-label="Sugar" @click="page='projects'; loadBasics()"><img src="/sugar-mark.png" alt="" width="32" height="32"><span>Sugar</span></button><div v-if="page==='editor' && project" class="sugar-project-toolbar"><div class="breadcrumb"><button @click="page='projects'; loadBasics()">{{ t('projects') }}</button><span>/</span><strong>{{ diagram.name }}</strong><span class="revision-pill">v{{ project.revision }}</span></div><div class="header-actions"><button class="secondary" :aria-label="paletteCollapsed ? t('showBlocks') : t('hideBlocks')" @click="paletteCollapsed=!paletteCollapsed"><Bars3Icon class="ui-icon" aria-hidden="true" /> {{ t('blocks') }}</button><button class="secondary" @click="exportYaml"><DocumentTextIcon class="ui-icon" aria-hidden="true" /> YAML</button><button class="secondary" @click="exportImage('svg')"><ArrowDownTrayIcon class="ui-icon" aria-hidden="true" /> SVG</button><button class="secondary" @click="exportImage('png')"><ArrowDownTrayIcon class="ui-icon" aria-hidden="true" /> PNG</button><button v-if="editable" class="primary" :disabled="busy || yamlDirty" @click="saveProject">{{ t('save') }}</button></div></div><span v-else class="topbar-caption">{{ t('welcomeSub') }}</span></header>
      <div class="workspace-shell">
      <aside class="sidebar transition-[width] duration-200" :class="sidebarCollapsed ? 'collapsed' : 'expanded'">
        <div class="rail-controls"><button class="sidebar-toggle" :title="sidebarCollapsed ? t('showSidebar') : t('hideSidebar')" :aria-label="sidebarCollapsed ? t('showSidebar') : t('hideSidebar')" @click="sidebarCollapsed=!sidebarCollapsed"><ChevronDoubleRightIcon v-if="sidebarCollapsed" class="ui-icon" aria-hidden="true" /><ChevronDoubleLeftIcon v-else class="ui-icon" aria-hidden="true" /></button></div>
        <nav><button :class="{ active: page === 'projects' || page === 'editor' }" @click="page='projects'; loadBasics()"><span><RectangleGroupIcon class="ui-icon" aria-hidden="true" /></span>{{ t('projects') }}</button><button :class="{ active: page === 'library' }" @click="openLibrary"><span><CubeIcon class="ui-icon" aria-hidden="true" /></span>{{ t('library') }}</button><button :class="{ active: page === 'gallery' }" @click="openGallery"><span><PhotoIcon class="ui-icon" aria-hidden="true" /></span>{{ t('gallery') }}</button><button v-if="accountEditable" :class="{ active: page === 'trash' }" @click="page='trash'"><span><TrashIcon class="ui-icon" aria-hidden="true" /></span>{{ t('trash') }}</button><button v-if="admin" :class="{ active: page === 'users' }" @click="openUsers"><span><UsersIcon class="ui-icon" aria-hidden="true" /></span>{{ t('users') }}</button><button :class="{ active: page === 'settings' }" @click="openSettings"><span><Cog6ToothIcon class="ui-icon" aria-hidden="true" /></span>{{ t('settings') }}</button></nav>
        <div class="sidebar-foot"><span class="avatar">{{ user.email[0].toUpperCase() }}</span><div><strong>{{ user.email }}</strong><small>{{ user.role }}</small></div><button class="icon-button" :title="t('signOut')" :aria-label="t('signOut')" @click="signOut"><ArrowRightStartOnRectangleIcon class="ui-icon" aria-hidden="true" /></button></div>
      </aside>
      <main class="main-area" :class="{'editor-main': page === 'editor' && project}">
        <div v-if="errorMessage" class="floating-message error" role="alert" aria-live="assertive"><span class="notice-icon" aria-hidden="true"><ExclamationCircleIcon class="ui-icon" /></span><div><strong>{{ t('errorTitle') }}</strong><p>{{ errorMessage }}</p></div><button :aria-label="t('close')" @click="errorMessage=''"><XMarkIcon class="ui-icon" aria-hidden="true" /></button></div><div v-if="notice" class="floating-message success" role="status"><CheckCircleIcon class="ui-icon" aria-hidden="true" /> {{ notice }} <button :aria-label="t('close')" @click="notice=''"><XMarkIcon class="ui-icon" aria-hidden="true" /></button></div>
        <template v-if="page === 'projects'"><header class="page-header"><div><div class="eyebrow">{{ t('workspace') }}</div><h1>{{ t('projects') }}</h1><p>{{ t('welcomeSub') }}</p></div><div class="header-actions"><button v-if="editable" class="secondary" @click="importInput?.click()"><ArrowUpTrayIcon class="ui-icon" aria-hidden="true" /> {{ t('import') }}</button><input ref="importInput" type="file" accept=".yaml,.yml,text/yaml" hidden @change="importProject(($event.target as HTMLInputElement).files?.[0])"><button v-if="editable" class="primary" @click="showNewProject=true"><PlusIcon class="ui-icon" aria-hidden="true" /> {{ t('newProject') }}</button></div></header>
          <div v-if="showNewProject" class="inline-form"><input v-model="newProjectName" :placeholder="t('name')" @keyup.enter="createProject"><button class="primary" @click="createProject">{{ t('create') }}</button><button class="secondary" @click="showNewProject=false">{{ t('cancel') }}</button></div>
          <div v-if="!projects.length" class="empty-state"><div><RectangleGroupIcon class="ui-icon icon-empty" aria-hidden="true" /></div><h2>{{ t('noProjects') }}</h2><p>{{ t('welcomeSub') }}</p></div>
          <div class="project-grid"><article v-for="p in projects" :key="p.id" class="project-card" @click="openProject(p.id)"><div class="project-icon"><FolderIcon class="ui-icon icon-card" aria-hidden="true" /></div><h2>{{ p.name }}</h2><p>{{ t('revision') }} {{ p.revision }} · {{ p.visibility === 'public' ? t('public') : t('private') }}</p><p>{{ t('creator') }}: {{ p.creator || t('unknownCreator') }}</p><div class="card-bottom"><button class="link-button" @click.stop="openProjectWithSettings(p.id)"><Cog6ToothIcon class="ui-icon" aria-hidden="true" /> {{ t('projectSettings') }}</button><button v-if="admin || (accountEditable && p.created_by === user.id)" class="text-danger" @click.stop="deleteProject(p.id)"><TrashIcon class="ui-icon" aria-hidden="true" /> {{ t('moveToTrash') }}</button><span v-else><ArrowTopRightOnSquareIcon class="ui-icon" aria-hidden="true" /></span></div></article></div><div class="header-actions project-pagination"><p class="hint" role="status">{{ t('projectsLoaded').replace('{count}', String(projects.length)) }}</p><button v-if="projectsCursor" class="secondary" :disabled="busy || projectsLoading" @click="moreProjects">{{ t('loadMoreProjects') }}</button></div>
        </template>
        <template v-else-if="page === 'editor' && project">
          <div class="editor-layout" :class="{'palette-hidden':paletteCollapsed}" :style="{'--yaml-panel-width': yamlPanelWidth + 'px'}"><aside class="palette"><div class="section-heading"><h3>{{ t('blocks') }}</h3><span>{{ blocks.length }}</span></div><p class="hint">{{ t('dragHint') }}</p><BlockCatalog :items="blocks" :categories="categories" mode="palette" :editable="editable" :language="lang" @add="makeNode" @dragstart="dragStart" /><CategoryPagesControl :cursor="categoriesCursor" :loading="busy || categoriesLoading" :count="categories.length" :language="lang" @more="moreCategories" /><div class="pagination-controls"><button v-if="blocksCursor" class="secondary wide" :disabled="busy || blocksLoading || categoriesLoading" @click="moreBlocks">{{ t('loadMoreBlocks') }}</button><p class="hint" role="status">{{ t('blocksLoaded').replace('{count}', String(blocks.length)) }}</p><p v-if="blocksCursor" class="hint">{{ t('blockSearchLoaded') }}</p></div></aside>
            <div class="canvas" @dragover.prevent @drop="dropBlock"><VueFlow v-model:nodes="flowNodes" v-model:edges="flowEdges" :nodes-draggable="editable" :nodes-connectable="editable" :elements-selectable="true" :delete-key-code="null" fit-view-on-init @connect="connect" @node-click="selectedNode=$event.node.id; selectedEdge=null; panel='properties'" @edge-click="selectedEdge=$event.edge.id; selectedNode=null; panel='properties'" @pane-click="selectedNode=null; selectedEdge=null"><Background pattern-color="#8b95a8" :gap="20" :size="1" /><Controls /><template #edge-routed="edgeProps"><RoutedEdge v-bind="edgeProps" /></template><template #node-hardware="{ data }"><div class="hardware-node"><div class="node-header" :class="{ 'has-custom-color': !!safeHexColor(data.block.color) }" :style="headerStyle(data.block.color)"><span class="node-symbol"><BlockSymbol :block="data.block" :icons="categoryIconMap" class="icon-node" /></span><strong>{{ data.block.name }}</strong></div><div class="node-model">{{ data.block.model || data.block.function }}</div><div v-for="port in data.block.ports" :key="port.id" class="node-port"><Handle v-if="port.direction !== 'out'" :id="port.id" type="target" :position="Position.Left" :style="safePortColor(port.color) ? { backgroundColor: port.color } : undefined" /><span>{{ port.label }}</span><em>{{ port.protocol }}</em><Handle v-if="port.direction !== 'in'" :id="port.id" type="source" :position="Position.Right" :style="safePortColor(port.color) ? { backgroundColor: port.color } : undefined" /></div></div></template></VueFlow><div v-if="!diagram.nodes.length" class="canvas-hint"><CpuChipIcon class="ui-icon icon-empty" aria-hidden="true" /><p>{{ t('insertHint') }}</p></div><button class="primary ai-canvas-button" @click="openAi"><SparklesIcon class="ui-icon" aria-hidden="true" /> {{ t('aiReview') }}</button></div>
            <aside class="inspector"><div class="tabs"><button :class="{active: panel==='ai'}" @click="openAi"><SparklesIcon class="ui-icon" aria-hidden="true" /> {{ t('ai') }}</button><button :class="{active: panel==='properties'}" @click="panel='properties'"><WrenchScrewdriverIcon class="ui-icon" aria-hidden="true" /> {{ t('properties') }}</button><button :class="{active: panel==='yaml'}" @click="panel='yaml'"><CodeBracketIcon class="ui-icon" aria-hidden="true" /> YAML</button><button :class="{active: panel==='history'}" @click="panel='history'; loadRevisions()"><ClockIcon class="ui-icon" aria-hidden="true" /> {{ t('history') }}</button><button :class="{active: panel==='settings'}" @click="openProjectSettings"><Cog6ToothIcon class="ui-icon" aria-hidden="true" /> {{ t('projectSettings') }}</button></div>
              <AiPanel v-show="panel==='ai'" :key="user?.id + ':' + user?.role + ':' + project.id + ':' + editable" :project-id="project.id" :revision="project.revision" :snapshot="diagram" :yaml-dirty="yamlDirty" :editable="editable" :language="lang" @select="selectAiNode" />
              <div v-if="panel==='properties'" class="inspector-content"><template v-if="selected"><div class="eyebrow">{{ t('select') }}</div><h2>{{ selected.block.name }}</h2><label>{{ t('name') }}<input :value="selected.block.name" :disabled="!editable" @input="updateNodeField('name',($event.target as HTMLInputElement).value)"></label><label>{{ t('function') }}<input :value="selected.block.function" :disabled="!editable" @input="updateNodeField('function',($event.target as HTMLInputElement).value)"></label><label>{{ t('model') }}<input :value="selected.block.model" :disabled="!editable" @input="updateNodeField('model',($event.target as HTMLInputElement).value)"></label><div class="image-field mt-5 rounded-xl border border-[var(--border)] p-3"><div class="mb-2 text-xs font-bold">{{ t('image') }}</div><img v-if="safeImage(selected.block.image)" :src="safeImage(selected.block.image)" :alt="selected.block.name" class="mb-3 h-20 w-20 rounded-lg object-cover"><input :value="selected.block.image || ''" type="text" :placeholder="t('imageUrlPlaceholder')" :disabled="!editable" class="w-full" @change="updateNodeField('image',($event.target as HTMLInputElement).value)"><p class="hint">{{ t('copyFromGallery') }}</p></div><div class="block-extra-fields"><label>{{ t('blockHeaderColor') }}<div class="block-color-inputs"><input type="color" :value="safeHexColor(selected.block.color) || '#64748b'" :disabled="!editable" :aria-label="t('blockHeaderColor')" @change="setNodeColor(($event.target as HTMLInputElement).value)"><input type="text" :value="selected.block.color || ''" placeholder="#RRGGBB" :disabled="!editable" :aria-label="t('blockHeaderColorHex')" @change="setNodeColor(($event.target as HTMLInputElement).value)"><button v-if="editable && selected.block.color" class="secondary" @click="setNodeColor('')">{{ t('clearColor') }}</button></div></label><label>{{ t('notes') }}<textarea :value="typeof selected.block.properties?.notes === 'string' ? selected.block.properties.notes : ''" :disabled="!editable" rows="4" @change="setNodeNotes(($event.target as HTMLTextAreaElement).value)"></textarea></label></div><div class="section-heading"><h3>{{ t('blockProperties') }}</h3></div><div v-for="[key, value] in Object.entries(selected.block.properties || {}).filter(([key]) => key !== 'url' && key !== 'urls' && key !== 'notes')" :key="key" class="block-property-row"><span>{{ key }}</span><strong>{{ formatProperty(value) }}</strong></div><p v-if="!Object.keys(selected.block.properties || {}).some(key => key !== 'url' && key !== 'urls' && key !== 'notes')" class="hint">{{ t('noBlockProperties') }}</p><div class="section-heading"><h3>{{ t('links') }}</h3></div><div v-for="link in propertyLinks(selected.block.properties)" :key="link.index" class="property-link-row"><input :aria-label="t('linkName')" :value="link.label" :disabled="!editable" @change="applyNodeLink(link.index, ($event.target as HTMLInputElement).value, link.url)"><input :aria-label="t('linkUrl')" type="url" :value="link.url" :disabled="!editable" @change="applyNodeLink(link.index, link.label, ($event.target as HTMLInputElement).value)"><div class="property-link-actions"><a v-if="safeExternalUrl(link.url)" class="datasheet-link" :href="safeExternalUrl(link.url)" target="_blank" rel="noopener noreferrer"><LinkIcon class="ui-icon" aria-hidden="true" /> {{ t('openLink') }}</a><button v-if="editable" class="link-button" :aria-label="t('removeLink')" @click="applyNodeLink(link.index, link.label, link.url, true)">{{ t('removeLink') }}</button></div></div><div v-if="editable" class="property-link-add"><input v-model="nodeLinkLabel" :aria-label="t('linkName')" :placeholder="t('linkName')"><input v-model="nodeLinkUrl" :aria-label="t('linkUrl')" type="url" placeholder="https://..."><button class="secondary" @click="applyNodeLink(Number.MAX_SAFE_INTEGER, nodeLinkLabel, nodeLinkUrl)">{{ t('addLink') }}</button></div><div class="detail-line"><span>{{ t('version') }}</span><strong>{{ selected.libraryVersion || '—' }}</strong></div><button v-if="editable && selected.libraryId && blocks.find(b=>b.id===selected?.libraryId)?.latest_version !== selected.libraryVersion" class="secondary wide" @click="updateNodeToLatest">{{ t('updated') }}</button><div class="section-heading"><h3>{{ t('ports') }}</h3></div><div v-for="port in selected.block.ports" :key="port.id" class="port-detail"><span>{{ port.label }}</span><code><span v-if="safePortColor(port.color)" class="port-color-swatch" :style="{ backgroundColor: port.color }"></span>{{ port.protocol }} · {{ port.direction }}{{ port.color ? ' · ' + port.color : '' }}</code></div><button v-if="editable" class="danger wide" @click="removeNode">{{ t('removeNode') }}</button></template><template v-else-if="selectedEdge"><h2>{{ t('connections') }}</h2><p class="hint">{{ t('routeHint') }}</p><button v-if="editable" class="secondary wide" @click="resetEdgeRoute"><ArrowPathIcon class="ui-icon" aria-hidden="true" /> {{ t('resetRoute') }}</button><button v-if="editable" class="danger wide" @click="removeEdge">{{ t('removeEdge') }}</button></template><div v-else class="inspector-empty"><CubeIcon class="ui-icon icon-empty" aria-hidden="true" /><p>{{ t('select') }}</p></div></div>

              <div v-else-if="panel==='yaml'" class="inspector-content yaml-content"><label class="yaml-width-control">{{ t('editorWidth') }} <span>{{ yamlPanelWidth }} px</span><input v-model.number="yamlPanelWidth" type="range" min="300" max="800" step="10" :aria-label="t('editorWidth')"></label><p class="hint">{{ t('blockYaml') }}</p><DocumentLimitsHint kind="project" :language="lang" /><textarea v-model="yamlDraft" spellcheck="false" :readonly="!editable" @input="onYamlInput"></textarea><div v-if="yamlError" class="message error">{{ yamlError }}</div><button v-if="editable" class="secondary wide" :disabled="!yamlDirty" @click="applyYaml">{{ t('apply') }}</button></div>
              <div v-else-if="panel==='settings'" class="inspector-content project-settings-panel"><h2>{{ t('projectSettings') }}</h2><div class="detail-line"><span>{{ t('creator') }}</span><strong>{{ project.creator || t('unknownCreator') }}</strong></div><div class="detail-line"><span>{{ t('createdAt') }}</span><strong>{{ new Date(project.created_at || '').toLocaleString(lang) }}</strong></div><label>{{ t('visibility') }}<select v-model="projectSettings.visibility" :disabled="!projectOwner"><option value="private">{{ t('private') }}</option><option value="public">{{ t('public') }}</option></select></label><p class="hint">{{ projectSettings.visibility === 'public' ? t('publicHint') : t('privateHint') }}</p><label>{{ t('projectRepository') }}<input v-model="projectSettings.sync_repository" placeholder="owner/repo" :disabled="!projectOwner"></label><label>{{ t('branch') }}<input v-model="projectSettings.sync_branch" placeholder="main" :disabled="!projectOwner"></label><p class="hint">{{ t('projectRepoHint') }}</p><p v-if="projectSettings.visibility==='private' && projectSettings.sync_repository" class="hint">{{ t('privateRepoHint') }}</p><button v-if="projectOwner" class="primary wide" :disabled="busy" @click="saveProjectSettings">{{ t('saveSettings') }}</button><div class="share-section"><h3>{{ t('share') }}</h3><p v-if="project.visibility==='private'" class="hint">{{ t('shareExpiryHint') }}</p><button v-if="projectOwner || project.visibility==='public'" class="secondary wide" :disabled="projectSettingsDirty" @click="shareProject"><ShareIcon class="ui-icon" aria-hidden="true" /> {{ t('share') }}</button><p v-if="projectSettingsDirty" class="hint">{{ t('saveBeforeSharing') }}</p><label v-if="shareUrl">{{ t('shareLink') }}<input :value="shareUrl" readonly @focus="($event.target as HTMLInputElement).select()"></label><button v-if="projectOwner && project.visibility==='private'" class="link-button" @click="revokeShare">{{ t('revokeLink') }}</button></div><div class="sync-section"><div class="section-heading"><h3>{{ t('sync') }}</h3><button v-if="projectOwner && project.sync_repository" class="link-button" @click="retryProjectSync">{{ t('retry') }}</button></div><p v-if="!project.sync_repository" class="hint">{{ t('syncNotConfigured') }}</p><div v-for="job in projectSyncJobs" :key="job.created_at + job.revision" class="version-row"><span>v{{ job.revision }} · {{ job.target_repository }}</span><small :title="job.error">{{ job.status }}{{ job.error ? ' · ' + job.error : '' }}</small></div></div><div class="settings-history"><ProjectMembers v-if="projectOwner && project" :key="user?.id + ':' + user?.role + ':' + project.id" :project-id="project.id" :language="lang" /><p v-if="!editable" class="hint">{{ t('readOnlyProject') }}</p><h3>{{ t('settingsHistory') }}</h3><div v-for="item in projectSettingsHistory" :key="item.id" class="history-item"><small>{{ item.author || 'system' }} · {{ new Date(item.created_at).toLocaleString(lang) }}</small><p>{{ item.before.visibility }} → {{ item.after.visibility }} · {{ item.before.sync_repository || '—' }} → {{ item.after.sync_repository || '—' }}</p></div><button v-if="settingsHistoryCursor" class="secondary wide" :disabled="busy || settingsHistoryLoading" @click="moreSettingsHistory">{{ t('loadMoreSettingsHistory') }}</button><p class="hint" role="status">{{ t('settingsHistoryLoaded').replace('{count}', String(projectSettingsHistory.length)) }}</p></div></div>
              <div v-else-if="panel==='history'" class="inspector-content"><h2>{{ t('history') }}</h2><p v-if="!revisions.length" class="hint">{{ t('emptyHistory') }}</p><div v-for="r in revisions" :key="r.revision" class="history-item"><div><strong>v{{ r.revision }}</strong><small>{{ new Date(r.created_at).toLocaleString(lang) }}</small></div><p>{{ r.summary }}</p><small>{{ r.author || 'system' }}</small><button v-if="editable && r.revision !== project.revision" class="link-button" @click="restoreRevision(r.revision!)">{{ t('restore') }}</button></div><button v-if="revisionsCursor" class="secondary wide" :disabled="busy || revisionsLoading" @click="moreRevisions">{{ t('loadMoreRevisions') }}</button><p class="hint" role="status">{{ t('revisionsLoaded').replace('{count}', String(revisions.length)) }}</p><div class="compare-box"><h3>{{ t('compare') }}</h3><select v-model.number="compareFrom"><option :value="null">—</option><option v-for="r in revisions" :key="r.revision" :value="r.revision">v{{ r.revision }}</option></select><select v-model.number="compareTo"><option :value="null">—</option><option v-for="r in revisions" :key="r.revision" :value="r.revision">v{{ r.revision }}</option></select><button class="secondary wide" @click="compareRevisions">{{ t('compare') }}</button><DocumentLimitsHint kind="comparison" :language="lang" /><pre v-if="diffText" class="diff">{{ diffText }}</pre></div></div>
            </aside></div><div v-if="editable && panel!=='settings'" class="save-strip"><span>{{ t('summary') }}</span><input v-model="changeSummary" :placeholder="t('summary')"><span v-if="yamlDirty" class="dirty-indicator">{{ t('invalid') }}</span></div>
        </template>
        <template v-else-if="page==='library'"><header class="page-header"><div><div class="eyebrow">{{ t('reusable') }}</div><h1>{{ t('library') }}</h1><p>{{ t('blocks') }} · {{ blocks.length }}</p></div><button v-if="editable" class="primary" @click="newBlock"><PlusIcon class="ui-icon" aria-hidden="true" /> {{ t('newBlock') }}</button></header><details v-if="editable" class="category-admin"><summary>{{ t('manageCategories') }}</summary><div class="category-admin-content"><p class="hint">{{ t('libraryScopeHint') }}</p><label v-if="admin">{{ t('libraryScope') }}<select v-model="newCategoryScope"><option value="personal">{{ t('libraryPersonal') }}</option><option value="catalog">{{ t('libraryCatalog') }}</option></select></label><CategoryPagesControl :cursor="categoriesCursor" :loading="busy || categoriesLoading" :count="categories.length" :language="lang" @more="moreCategories" /><div class="category-create"><input v-model="newCategoryName" :aria-label="t('categoryName')" :placeholder="t('categoryName')"><select v-model="newCategoryParent" :aria-label="t('parentCategory')"><option value="">{{ t('mainCategory') }}</option><option v-for="root in categoryCreationRoots" :key="root.id" :value="root.id">{{ root.name }} · {{ root.owner_id ? t('libraryPersonal') : t('libraryCatalog') }}</option></select><IconPicker v-model="newCategoryIcon" :language="lang" :inheritable="!!newCategoryParent" :inherited-icon="categories.find(c => c.id===newCategoryParent)?.icon" /><button class="primary" :disabled="busy || !newCategoryName.trim() || (!newCategoryParent && !newCategoryIcon)" @click="createCatalogCategory">{{ t('create') }}</button></div><div v-for="category in activeCategories.filter(c => c.permissions?.canEdit)" :key="category.id" class="category-admin-row"><CategorySymbol :icon="categoryIconEdits[category.id] || categories.find(c => c.id===category.parent_id)?.icon" /><input v-model="categoryEdits[category.id]" :aria-label="t('categoryName')"><small>{{ category.slug }}</small><IconPicker v-model="categoryIconEdits[category.id]" :language="lang" :inheritable="!!category.parent_id" :inherited-icon="categories.find(c => c.id===category.parent_id)?.icon" /><button class="secondary" :disabled="busy || (categoryEdits[category.id] === category.name && categoryIconEdits[category.id] === category.icon)" @click="renameCatalogCategory(category)">{{ t('saveSettings') }}</button><button class="text-danger" :disabled="busy" @click="deleteCatalogCategory(category)">{{ t('delete') }}</button></div></div></details><div class="library-layout" :class="{'library-wide':libraryWide}"><div class="library-list"><BlockCatalog :items="blocks" :categories="categories" mode="library" :selected-id="blockSelection?.id" :editable="editable" :language="lang" @select="selectBlock" /><CategoryPagesControl :cursor="categoriesCursor" :loading="busy || categoriesLoading" :count="categories.length" :language="lang" @more="moreCategories" /><div class="pagination-controls"><button v-if="blocksCursor" class="secondary wide" :disabled="busy || blocksLoading || categoriesLoading" @click="moreBlocks">{{ t('loadMoreBlocks') }}</button><p class="hint" role="status">{{ t('blocksLoaded').replace('{count}', String(blocks.length)) }}</p><p v-if="blocksCursor" class="hint">{{ t('blockSearchLoaded') }}</p></div></div><div class="library-detail" v-if="blockSelection || showNewBlock"><div class="detail-title"><h2>{{ blockSelection?.name || t('newBlock') }}</h2><p v-if="blockSelection" class="hint">{{ blockSelection.permissions?.scope === 'personal' ? t('libraryPersonal') : t('libraryCatalog') }}</p><button v-if="blockSelection && editable" class="secondary" @click="copyLibraryBlock">{{ t('copyToPersonal') }}</button><label v-if="showNewBlock && admin">{{ t('libraryScope') }}<select v-model="newBlockScope"><option value="personal">{{ t('libraryPersonal') }}</option><option value="catalog">{{ t('libraryCatalog') }}</option></select></label><span v-if="blockSelection" class="revision-pill">v{{ blockSelection.latest_version }}</span></div><div class="block-classification"><label>{{ t('category') }}<select :value="blockDraftCategory()" :disabled="!libraryEditable" @change="applyBlockCategory(($event.target as HTMLSelectElement).value)"><option value="">{{ t('selectCategory') }}</option><option v-for="root in blockCategoryRoots" :key="root.id" :value="root.slug">{{ root.name }} · {{ root.owner_id ? t('libraryPersonal') : t('libraryCatalog') }}</option></select></label><label>{{ t('subcategory') }}<select :value="blockDraftSubcategory()" :disabled="!libraryEditable || !blockDraftCategory()" @change="applyBlockCategory(blockDraftCategory(), ($event.target as HTMLSelectElement).value)"><option value="">{{ t('noSubcategory') }}</option><option v-for="child in childCategories(blockDraftCategory())" :key="child.id" :value="child.slug">{{ child.name }}</option></select></label></div><CategoryPagesControl :cursor="categoriesCursor" :loading="busy || categoriesLoading" :count="categories.length" :language="lang" @more="moreCategories" /><p v-if="!rootCategories.some(category => category.slug === blockDraftCategory())" class="hint">{{ t('categoryRequired') }}</p><div class="block-extra-fields"><label>{{ t('blockHeaderColor') }}<div class="block-color-inputs"><input type="color" :value="libraryColor(blockDraft) || '#64748b'" :disabled="!libraryEditable" :aria-label="t('blockHeaderColor')" @change="setBlockColor(($event.target as HTMLInputElement).value)"><input type="text" :value="libraryColor(blockDraft) || ''" placeholder="#RRGGBB" :disabled="!libraryEditable" :aria-label="t('blockHeaderColorHex')" @change="setBlockColor(($event.target as HTMLInputElement).value)"><button v-if="libraryEditable && libraryColor(blockDraft)" class="secondary" @click="setBlockColor('')">{{ t('clearColor') }}</button></div></label><label>{{ t('notes') }}<textarea :value="typeof libraryProperties(blockDraft).notes === 'string' ? libraryProperties(blockDraft).notes as string : ''" :disabled="!libraryEditable" rows="4" @change="setBlockNotes(($event.target as HTMLTextAreaElement).value)"></textarea></label></div><div class="image-field my-5 rounded-xl border border-[var(--border)] p-4"><div class="mb-2 text-sm font-bold">{{ t('image') }}</div><img v-if="imageFromYaml(blockDraft)" :src="imageFromYaml(blockDraft)" :alt="blockSelection?.name || t('newBlock')" class="mb-3 h-24 w-24 rounded-lg object-cover"><label>{{ t('imageUrl') }}<input :value="imageFromYaml(blockDraft)" type="text" :placeholder="t('imageUrlPlaceholder')" :disabled="!libraryEditable" @change="setBlockImage(($event.target as HTMLInputElement).value)"></label><p class="hint">{{ t('copyFromGallery') }}</p></div><div class="section-heading"><h3>{{ t('links') }}</h3></div><div v-for="link in propertyLinks(libraryProperties(blockDraft))" :key="link.index" class="property-link-row"><input :aria-label="t('linkName')" :value="link.label" :disabled="!libraryEditable" @change="applyBlockLink(link.index, ($event.target as HTMLInputElement).value, link.url)"><input :aria-label="t('linkUrl')" type="url" :value="link.url" :disabled="!libraryEditable" @change="applyBlockLink(link.index, link.label, ($event.target as HTMLInputElement).value)"><div class="property-link-actions"><a v-if="safeExternalUrl(link.url)" class="datasheet-link" :href="safeExternalUrl(link.url)" target="_blank" rel="noopener noreferrer"><LinkIcon class="ui-icon" aria-hidden="true" /> {{ t('openLink') }}</a><button v-if="libraryEditable" class="link-button" :aria-label="t('removeLink')" @click="applyBlockLink(link.index, link.label, link.url, true)">{{ t('removeLink') }}</button></div></div><div v-if="libraryEditable" class="property-link-add"><input v-model="libraryLinkLabel" :aria-label="t('linkName')" :placeholder="t('linkName')"><input v-model="libraryLinkUrl" :aria-label="t('linkUrl')" type="url" placeholder="https://..."><button class="secondary" @click="applyBlockLink(Number.MAX_SAFE_INTEGER, libraryLinkLabel, libraryLinkUrl)">{{ t('addLink') }}</button></div><div class="yaml-editor-heading"><p class="hint">{{ t('blockYaml') }}</p><button class="secondary" :aria-pressed="libraryWide" @click="libraryWide=!libraryWide">{{ libraryWide ? t('normalWidth') : t('wideEditor') }}</button></div><DocumentLimitsHint kind="block" :language="lang" /><textarea v-model="blockDraft" class="block-editor" spellcheck="false" :readonly="!libraryEditable"></textarea><div v-if="errorMessage" class="message error inline-error" role="alert">{{ errorMessage }}</div><div class="inline-form" v-if="libraryEditable"><input v-model="blockSummary" :placeholder="t('summary')"><button class="primary" @click="saveBlock">{{ t('save') }}</button><button v-if="blockSelection && libraryEditable" class="danger" @click="deleteBlock">{{ t('moveToTrash') }}</button></div><div v-if="pendingBlockRestore !== null" class="restore-category"><p class="hint">{{ t('restoreCategoryHint') }}</p><select v-model="restoreCategory" :aria-label="t('category')" @change="restoreSubcategory=''"><option value="">{{ t('selectCategory') }}</option><option v-for="root in blockCategoryRoots" :key="root.id" :value="root.slug">{{ root.name }} · {{ root.owner_id ? t('libraryPersonal') : t('libraryCatalog') }}</option></select><select v-model="restoreSubcategory" :aria-label="t('subcategory')" :disabled="!restoreCategory"><option value="">{{ t('noSubcategory') }}</option><option v-for="child in childCategories(restoreCategory)" :key="child.id" :value="child.slug">{{ child.name }}</option></select><button class="secondary" :disabled="!restoreCategory || busy" @click="confirmBlockRestore">{{ t('restore') }}</button><button class="link-button" @click="pendingBlockRestore=null">{{ t('cancel') }}</button></div><div v-if="blockSelection"><h3>{{ t('blockVersions') }}</h3><div v-for="v in blockVersions" :key="v.version" class="version-row"><span>v{{ v.version }} · {{ v.summary }}</span><small>{{ v.author || 'system' }}</small><button class="link-button" @click="viewBlockVersion(v.version!)">{{ t('view') }}</button><button v-if="libraryEditable && v.version !== blockSelection.latest_version" class="link-button" @click="restoreBlockVersion(v.version!)">{{ t('restore') }}</button></div><div class="pagination-controls"><button v-if="blockVersionsCursor" class="secondary" :disabled="busy || blockVersionsLoading" @click="moreBlockVersions">{{ t('loadMoreVersions') }}</button><p class="hint" role="status">{{ t('versionsLoaded').replace('{count}', String(blockVersions.length)) }}</p></div><div class="compare-box"><h3>{{ t('compare') }}</h3><select v-model.number="blockCompareFrom"><option :value="null">—</option><option v-for="v in blockVersions" :key="v.version" :value="v.version">v{{ v.version }}</option></select><select v-model.number="blockCompareTo"><option :value="null">—</option><option v-for="v in blockVersions" :key="v.version" :value="v.version">v{{ v.version }}</option></select><button class="secondary" @click="compareBlockVersions">{{ t('compare') }}</button><DocumentLimitsHint kind="comparison" :language="lang" /><pre v-if="blockDiffText" class="diff">{{ blockDiffText }}</pre></div></div></div><div v-else class="empty-state"><CubeIcon class="ui-icon icon-empty" aria-hidden="true" /><p>{{ t('select') }}</p></div></div></template>
        <template v-else-if="page==='gallery'"><header class="page-header"><div><div class="eyebrow">{{ t('imageCollection') }}</div><h1>{{ t('gallery') }}</h1><p>{{ t('galleryHint') }}</p></div><div v-if="editable" class="header-actions"><label v-if="admin">{{ t('libraryScope') }}<select v-model="imageScope"><option value="personal">{{ t('libraryPersonal') }}</option><option value="catalog">{{ t('libraryCatalog') }}</option></select></label><button class="primary" :disabled="busy" @click="galleryInput?.click()"><ArrowUpTrayIcon class="ui-icon" aria-hidden="true" /> {{ t('uploadImage') }}</button><input ref="galleryInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="uploadGalleryImage(($event.target as HTMLInputElement).files?.[0])"></div></header><div class="gallery-content"><ImageStoragePanel :key="'image-storage:' + user.id + user.role" :language="lang" :refresh-key="galleryStorageVersion" /><p class="hint">{{ t('imageLimit') }}</p><div v-if="!galleryImages.length" class="empty-state"><div><PhotoIcon class="ui-icon icon-empty" aria-hidden="true" /></div><h2>{{ t('noImages') }}</h2></div><div class="gallery-grid"><article v-for="img in galleryImages" :key="img.id" class="gallery-card"><div class="gallery-preview"><img :src="img.url" :alt="img.name"></div><div class="gallery-info"><strong :title="img.name">{{ img.name }}</strong><small>{{ img.scope === 'catalog' ? t('libraryCatalog') : t('libraryPersonal') }}</small><small>{{ img.creator || t('unknownCreator') }} · {{ new Date(img.created_at).toLocaleDateString(lang) }}</small><input :value="img.url" readonly :aria-label="t('imageUrl')" @focus="($event.target as HTMLInputElement).select()"><div class="gallery-actions"><button class="secondary" @click="copyImageUrl(img.url)">{{ t('copyUrl') }}</button><button v-if="admin || (accountEditable && img.owner_id === user.id && img.scope !== 'catalog')" class="text-danger" @click="deleteGalleryImage(img.id)">{{ t('moveToTrash') }}</button></div></div></article></div><div class="header-actions gallery-pagination"><p class="hint" role="status">{{ t('galleryLoaded').replace('{count}', String(galleryImages.length)) }}</p><button v-if="galleryCursor" class="secondary" :disabled="busy || galleryLoading" @click="moreGallery">{{ t('loadMoreImages') }}</button></div></div></template>
        <template v-else-if="page==='users'"><header class="page-header"><div><div class="eyebrow">{{ t('teamAccess') }}</div><h1>{{ t('users') }}</h1></div><button class="secondary" :disabled="busy || usersLoading" @click="manageUsers()">{{ t('reloadUsers') }}</button></header><div class="content-card"><h2>{{ t('createUser') }}</h2><div class="inline-form"><input v-model="createEmail" type="email" :placeholder="t('email')"><input v-model="createPassword" type="password" :placeholder="t('password') + ' (12+)' "><select v-model="createRole"><option>view</option><option>dev</option><option>Admin</option></select><button class="primary" :disabled="busy || usersLoading" @click="createUser">{{ t('create') }}</button></div><div v-for="member in users" :key="member.id" class="user-row"><span class="avatar">{{ member.email[0].toUpperCase() }}</span><strong>{{ member.email }}</strong><span v-if="!member.active" class="muted">{{ t('inactive') }}</span><select :value="member.role" :disabled="busy || usersLoading || member.id===user.id || !member.active" @change="setRole(member.id,($event.target as HTMLSelectElement).value)"><option>view</option><option>dev</option><option>Admin</option></select><button class="text-danger" :disabled="busy || usersLoading || member.id===user.id || !member.active" @click="deleteUser(member.id)">{{ t('deleteUser') }}</button></div><p class="hint" role="status">{{ t('usersLoaded').replace('{count}', String(users.length)) }}</p><button v-if="usersCursor" class="secondary wide" :disabled="busy || usersLoading" @click="moreUsers">{{ t('loadMoreUsers') }}</button></div></template>
        <template v-else-if="page==='trash'"><header class="page-header"><div><div class="eyebrow">{{ t('trashEyebrow') }}</div><h1>{{ t('trash') }}</h1></div></header><TrashPanel :key="'trash:' + user.id + user.role" :language="lang" :admin="admin" @changed="loadBasics(); galleryStorageVersion++" /></template>
        <template v-else-if="page==='settings'"><header class="page-header"><div><div class="eyebrow">{{ t('preferences') }}</div><h1>{{ t('settings') }}</h1></div></header><div class="settings-grid"><MfaSettings :key="'mfa:' + user.id + user.role" :admin="admin" :language="lang" @changed="mfaSessionEpoch++" /><SessionsPanel :key="'sessions:' + user.id + mfaSessionEpoch" :language="lang" /><AccountEmailSettings :language="lang" /><MailSettings v-if="admin" :language="lang" /><AiSettings v-if="admin" :language="lang" /><AiQuotaSettings v-if="admin" :language="lang" /><ImageStoragePanel v-if="admin" :key="'image-storage:' + user.id + user.role" admin :language="lang" /><DocumentStoragePanel :key="'document-storage:' + user.id + user.role" :admin="admin" :language="lang" /><TotalStoragePanel v-if="admin" :key="'total-storage:' + user.id" :language="lang" /><section class="content-card"><h2>{{ t('theme') }}</h2><div class="segmented"><button :class="{active:user.theme==='dark'}" @click="updatePreference('theme','dark')"><MoonIcon class="ui-icon" aria-hidden="true" /> {{ t('dark') }}</button><button :class="{active:user.theme==='light'}" @click="updatePreference('theme','light')"><SunIcon class="ui-icon" aria-hidden="true" /> {{ t('light') }}</button></div><h2>{{ t('language') }}</h2><div class="segmented"><button :class="{active:user.language==='es'}" @click="updatePreference('language','es')">Español</button><button :class="{active:user.language==='en'}" @click="updatePreference('language','en')">English</button></div></section><section class="content-card"><h2>{{ t('changePassword') }}</h2><label>{{ t('currentPassword') }}<input v-model="currentPassword" type="password"></label><label>{{ t('newPassword') }}<input v-model="newPassword" type="password" minlength="12"></label><button class="secondary" @click="changeOwnPassword">{{ t('save') }}</button></section></div></template>
      </main>
      </div>
    </template>
  </div>
</template>
