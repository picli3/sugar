import crypto from 'node:crypto'
import YAML from 'yaml'
import { documentLimits, parseYaml, validateDocumentBudget } from './model.js'
import { normalizeImage } from './images/normalization.js'

const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
export function imageBytes(mime, data) {
  if (!mimeTypes.has(mime) || typeof data !== 'string' || data.length > Math.ceil(documentLimits.imageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Object.assign(new Error('Imagen inválida. Usa PNG, JPEG o WebP / Invalid image. Use PNG, JPEG or WebP.'), { status: 400 })
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > 1_000_000 || bytes.toString('base64') !== data) throw Object.assign(new Error('La imagen debe pesar como máximo 1 MB / Image must not exceed 1 MB.'), { status: 400 })
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (!valid) throw Object.assign(new Error('El contenido no coincide con el tipo de imagen / Content does not match image type.'), { status: 400 })
  return bytes
}
export async function replaceEmbeddedImages(yaml, kind, tx, { ownerId = null, catalog = false, storage, maintenance = false } = {}) {
  if (!yaml.includes('data:image/')) return yaml
  const doc = parseYaml(yaml)
  validateDocumentBudget(doc, kind)
  const blocks = kind === 'project' ? doc.nodes?.map(n => n.block) : [doc]
  if (!Array.isArray(blocks)) return yaml
  let changed = false
  for (const block of blocks) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(block?.image || '')
    if (!match) continue
    const original = imageBytes(match[1], match[2])
    // Maintenance preserves existing legacy bytes; runtime restores validate and normalize.
    const bytes = maintenance ? original : await normalizeImage(match[1], original)
    if (storage) await storage.admit(tx, catalog ? null : ownerId, bytes.length)
    const id = crypto.randomUUID()
    await tx('INSERT INTO images(id,name,mime,data,owner_id,scope) VALUES($1,$2,$3,$4,$5,$6)', [id, `Imagen migrada ${id.slice(0, 8)}`, match[1], bytes, ownerId, catalog ? 'catalog' : 'personal'])
    block.image = `/api/images/${id}/content`
    changed = true
  }
  return changed ? YAML.stringify(doc, { lineWidth: 0 }) : yaml
}
