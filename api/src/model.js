import YAML from 'yaml'

const directions = ['in', 'out', 'bidirectional']
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }) }
const object = (v) => v && typeof v === 'object' && !Array.isArray(v)
const string = (v) => typeof v === 'string' && v.trim().length > 0
export const documentLimits = Object.freeze({ yamlBytes: 2_000_000, imageBytes: 1_000_000, imageSide: 4096, imagePixels: 4_000_000, imageConcurrent: 2, depth: 32, values: 200_000, nodes: 500, edges: 2000, portsPerBlock: 128, portsPerProject: 10_000, nameBytes: 800, descriptionBytes: 8000, identifierBytes: 256, protocolBytes: 400, summaryBytes: 8000, propertyKeys: 256, propertyKeyBytes: 200, links: 64, diffLines: 50_000, diffEdits: 10_000, diffTimeoutMs: 1000 })
const exceeds = (subject, maximum) => fail(`${subject}: máximo ${maximum}; reduce el contenido / maximum ${maximum}; reduce the content`)
const boundedText = (value, maximum, label) => { if (Buffer.byteLength(value, 'utf8') > maximum) exceeds(label + ' UTF-8 bytes', maximum) }
export function revisionSummary(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') fail('Resumen inválido / Invalid summary')
  boundedText(value, documentLimits.summaryBytes, 'Resumen / Summary')
  return value.trim() || fallback
}
export function validateDocumentBudget(value, kind) {
  let blocks = [value]
  if (kind === 'project') {
    const nodes = Array.isArray(value?.nodes) ? value.nodes : []
    if (nodes.length > documentLimits.nodes) exceeds('Bloques por proyecto / Blocks per project', documentLimits.nodes)
    if (Array.isArray(value?.edges) && value.edges.length > documentLimits.edges) exceeds('Conexiones por proyecto / Connections per project', documentLimits.edges)
    blocks = nodes.map(node => node?.block)
  }
  let totalPorts = 0
  for (const block of blocks) if (Array.isArray(block?.ports)) {
    if (block.ports.length > documentLimits.portsPerBlock) exceeds('Puertos por bloque / Ports per block', documentLimits.portsPerBlock)
    totalPorts += block.ports.length
  }
  if (kind === 'project' && totalPorts > documentLimits.portsPerProject) exceeds('Puertos por proyecto / Ports per project', documentLimits.portsPerProject)
}
const webUrl = (v) => {
  if (!string(v) || v.length > 2048) return false
  try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false }
}

export function normalizeColorLiterals(text) { return text.replace(/^([ \t]*color:[ \t]*)(#[0-9a-fA-F]{6})(?=[ \t]*(?:#.*)?\r?$)/gm, '$1"$2"') }

export function parseYaml(text) {
  if (typeof text !== 'string') fail('YAML vacío o demasiado grande')
  if (Buffer.byteLength(text, 'utf8') > documentLimits.yamlBytes) exceeds('YAML UTF-8 bytes', documentLimits.yamlBytes)
  let doc
  try { doc = YAML.parseDocument(normalizeColorLiterals(text), { uniqueKeys: true, maxAliasCount: 100 }) }
  catch { fail('YAML inválido / Invalid YAML') }
  if (doc.errors.length) fail(doc.errors[0].message)
  let count = 0
  YAML.visit(doc, (_key, _node, path) => {
    if (++count > documentLimits.values) exceeds('Valores YAML / YAML values', documentLimits.values)
    if (path.filter(YAML.isCollection).length > documentLimits.depth) exceeds('Profundidad YAML / YAML depth', documentLimits.depth)
  })
  let value
  try { value = doc.toJS({ maxAliasCount: 100 }) } catch { fail('Alias YAML inválido o excesivo / Invalid or excessive YAML alias') }
  // Alias targets can form cycles or expand the effective depth beyond the AST path.
  const pending = [{ value, depth: 0 }]
  count = 0
  let expandedBytes = 0
  while (pending.length) {
    const entry = pending.pop()
    if (++count > documentLimits.values) exceeds('Valores YAML / YAML values', documentLimits.values)
    if (entry.depth > documentLimits.depth) exceeds('Profundidad YAML / YAML depth', documentLimits.depth)
    if (typeof entry.value === 'string') expandedBytes += Buffer.byteLength(entry.value, 'utf8')
    if (entry.value && typeof entry.value === 'object') for (const key of Object.keys(entry.value)) {
      expandedBytes += Buffer.byteLength(key, 'utf8')
      if (pending.length + count >= documentLimits.values) exceeds('Valores YAML / YAML values', documentLimits.values)
      pending.push({ value: entry.value[key], depth: entry.depth + 1 })
    }
    if (expandedBytes > documentLimits.yamlBytes) exceeds('Contenido YAML expandido UTF-8 bytes / Expanded YAML UTF-8 bytes', documentLimits.yamlBytes)
  }
  return value
}

export function validateBlock(text) { return validateBlockValue(parseYaml(text)) }
function validateBlockValue(b) {
  if (!object(b) || !string(b.name) || !string(b.function)) fail('El bloque requiere name y function')
  boundedText(b.name, documentLimits.nameBytes, 'Nombre / Name')
  boundedText(b.function, documentLimits.descriptionBytes, 'Función / Function')
  if (b.category != null && (typeof b.category !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.category))) fail('category debe ser un identificador de categoría válido')
  if (b.subcategory != null && (typeof b.subcategory !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b.subcategory))) fail('subcategory debe ser un identificador válido')
  if (b.subcategory && !b.category) fail('subcategory requiere category')
  if (typeof b.category === 'string') boundedText(b.category, documentLimits.identifierBytes, 'Categoría / Category')
  if (typeof b.subcategory === 'string') boundedText(b.subcategory, documentLimits.identifierBytes, 'Subcategoría / Subcategory')
  if (b.model != null && typeof b.model !== 'string') fail('model debe ser texto')
  if (typeof b.model === 'string') boundedText(b.model, documentLimits.nameBytes, 'Modelo / Model')
  if (b.color != null && (typeof b.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(b.color))) fail('color del bloque debe ser RGB hexadecimal, por ejemplo "#FF0000"')
  if (b.image != null && b.image !== '') {
    if (typeof b.image !== 'string' || b.image.length > 2048 || !(b.image.startsWith('https://') || /^\/api\/images\/[0-9a-f-]{36}\/content$/.test(b.image))) fail('image debe ser una URL HTTPS o una ruta de la galería')
    if (b.image.startsWith('https://')) { try { new URL(b.image) } catch { fail('URL de imagen inválida') } }
  }
  if (b.properties != null && !object(b.properties)) fail('properties debe ser un mapa')
  if (b.properties) {
    const keys = Object.keys(b.properties)
    if (keys.length > documentLimits.propertyKeys) exceeds('Propiedades por bloque / Properties per block', documentLimits.propertyKeys)
    for (const key of keys) boundedText(key, documentLimits.propertyKeyBytes, 'Nombre de propiedad / Property name')
  }
  if (b.properties?.notes != null && typeof b.properties.notes !== 'string') fail('properties.notes debe ser texto')
  if (b.properties?.url != null && b.properties.url !== '') {
    if (!webUrl(b.properties.url)) fail('properties.url debe ser una URL HTTP o HTTPS')
  }
  if (b.properties?.urls != null) {
    if (!Array.isArray(b.properties.urls)) fail('properties.urls debe ser una lista de enlaces')
    if (b.properties.urls.length > documentLimits.links) exceeds('Enlaces por bloque / Links per block', documentLimits.links)
    for (const entry of b.properties.urls) {
      if (!object(entry) || Object.keys(entry).length !== 1) fail('Cada elemento de properties.urls debe tener un nombre y una URL')
      const [label, url] = Object.entries(entry)[0]
      if (!string(label) || label.length > 100 || !webUrl(url)) fail('Cada elemento de properties.urls debe tener un nombre y una URL HTTP o HTTPS')
    }
  }
  if (!Array.isArray(b.ports) || b.ports.length === 0) fail('El bloque requiere al menos un puerto')
  if (b.ports.length > documentLimits.portsPerBlock) exceeds('Puertos por bloque / Ports per block', documentLimits.portsPerBlock)
  const ids = new Set()
  for (const p of b.ports) {
    if (!object(p) || !string(p.id) || !string(p.label) || !string(p.protocol) || !directions.includes(p.direction)) fail('Puerto inválido: id, label, protocol y direction son obligatorios')
    boundedText(p.id, documentLimits.identifierBytes, 'Identificador / Identifier')
    boundedText(p.label, documentLimits.nameBytes, 'Etiqueta / Label')
    boundedText(p.protocol, documentLimits.protocolBytes, 'Protocolo / Protocol')
    if (ids.has(p.id)) fail(`Puerto duplicado: ${p.id}`)
    ids.add(p.id)
    if ('color' in p && (typeof p.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(p.color))) fail('color debe ser RGB hexadecimal, por ejemplo "#FF0000"')
    if (p.maxConnections != null && (!Number.isInteger(p.maxConnections) || p.maxConnections < 1)) fail('maxConnections debe ser un entero positivo')
  }
  return b
}

export function validateProject(text) {
  const p = parseYaml(text)
  if (!object(p) || !string(p.name) || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) fail('El proyecto requiere name, nodes y edges')
  boundedText(p.name, documentLimits.nameBytes, 'Nombre / Name')
  validateDocumentBudget(p, 'project')
  const nodes = new Map()
  for (const n of p.nodes) {
    if (!object(n) || !string(n.id) || !object(n.position) || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y) || !object(n.block)) fail('Nodo inválido')
    boundedText(n.id, documentLimits.identifierBytes, 'Identificador / Identifier')
    validateBlockValue(n.block)
    if (nodes.has(n.id)) fail(`Nodo duplicado: ${n.id}`)
    nodes.set(n.id, n)
  }
  const counts = new Map()
  const edgeIds = new Set()
  for (const e of p.edges) {
    if (!object(e) || !string(e.id) || !string(e.source) || !string(e.target) || !string(e.sourcePort) || !string(e.targetPort)) fail('Conexión inválida')
    for (const key of ['id','source','target','sourcePort','targetPort']) boundedText(e[key], documentLimits.identifierBytes, 'Identificador / Identifier')
    if (e.route != null && (!object(e.route) || !Number.isFinite(e.route.x) || !Number.isFinite(e.route.y))) fail('La posición de la conexión debe tener coordenadas x e y válidas')
    if (e.route && 'targetX' in e.route && !Number.isFinite(e.route.targetX)) fail('La posición del tramo junto al destino debe tener una coordenada targetX válida')
    if (edgeIds.has(e.id)) fail(`Conexión duplicada: ${e.id}`)
    edgeIds.add(e.id)
    const a = nodes.get(e.source), b = nodes.get(e.target)
    if (!a || !b || a === b) fail('La conexión debe unir dos bloques existentes')
    const ap = a.block.ports.find(x => x.id === e.sourcePort), bp = b.block.ports.find(x => x.id === e.targetPort)
    if (!ap || !bp) fail('La conexión referencia un puerto inexistente')
    if (ap.protocol.trim() !== bp.protocol.trim()) fail(`Protocolos incompatibles: ${ap.protocol} y ${bp.protocol}`)
    if (ap.direction === 'in' || bp.direction === 'out') fail('Dirección de puertos incompatible')
    for (const [id, port] of [[a.id, ap], [b.id, bp]]) {
      const key = `${id}:${port.id}`, count = (counts.get(key) || 0) + 1
      if (port.maxConnections && count > port.maxConnections) fail(`Límite de conexiones excedido: ${key}`)
      counts.set(key, count)
    }
  }
  return p
}

export const stringify = (value) => YAML.stringify(value, { lineWidth: 0 })
