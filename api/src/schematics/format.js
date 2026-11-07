import { error } from '../shared/http.js'

export const schematicMaxBytes = 1_000_000
const uuidPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
export const schematicId = new RegExp('^' + uuidPattern + '$')
const urlPattern = new RegExp('^/api/schematics/(' + uuidPattern + ')/content$')
export const schematicUrl = id => `/api/schematics/${id}/content`
export const schematicUrlId = value => typeof value === 'string' ? urlPattern.exec(value)?.[1] : undefined

function hasCompleteRoot(source) {
  let depth = 0, quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quoted && char === '\\') { i++; continue }
    if (char === '"') quoted = !quoted
    else if (!quoted && char === '(') depth++
    else if (!quoted && char === ')' && --depth === 0) return i === source.length - 1
  }
  return false
}

export function readSchematic(input) {
  if (!input || typeof input.name !== 'string' || input.name.length > 180 || !/\.kicad_sch$/i.test(input.name)) {
    error(400, 'Selecciona un archivo .kicad_sch / Choose a .kicad_sch file')
  }
  if (typeof input.data !== 'string' || !input.data.length) error(400, 'Archivo vacío o inválido / Empty or invalid file')
  const tooLarge = () => error(413, 'El esquema supera 1 MB / The schematic exceeds 1 MB')
  if (input.data.length > Math.ceil(schematicMaxBytes / 3) * 4) tooLarge()
  const data = Buffer.from(input.data, 'base64')
  if (data.length > schematicMaxBytes) tooLarge()
  if (data.toString('base64') !== input.data) error(400, 'Archivo inválido / Invalid file')
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { error(400, 'El esquema debe ser UTF-8 / The schematic must be UTF-8') }
  if (!/^\s*\(kicad_sch\s+\(version\s+\d{8}\s*\)\s+\(generator\s+/.test(source) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source) || !hasCompleteRoot(source.trim())) {
    error(400, 'El archivo no tiene formato de esquema KiCad / The file is not a KiCad schematic')
  }
  const basename = input.name.slice(0, -10).replace(/[^\p{L}\p{N} ._-]/gu, '_').trim()
  return { name: (basename || 'schematic') + '.kicad_sch', data }
}
