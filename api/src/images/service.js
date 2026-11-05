import crypto from 'node:crypto'
import { error, requiredText } from '../shared/http.js'
import { requireAdmin, requireEdit } from '../auth/policies.js'
import { imageBytes } from '../images.js'
import { normalizeImage } from './normalization.js'
import { imageIds, recordImageReferences } from './references.js'
import { pageInput, pageResult } from '../shared/pagination.js'
const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)

export function createImageService(images, storage) {
  const content = async (id, user, tx) => {
    const image = validId(id) && await images.content(id, user, tx)
    if (!image) error(404, 'Imagen no encontrada')
    return image
  }
  return {
    content,
    async shared(id, token) {
      const image = validId(id) && /^[A-Za-z0-9_-]{43}$/.test(token) && await images.shared(id, token)
      if (!image) error(404, 'Imagen no encontrada')
      return image
    },
    async attach(yaml, kind, id, user, tx) {
      const ids = imageIds(yaml, kind)
      // KEY SHARE serializes with purges: a purged or unknown ID grants nothing and does not
      // block saving documents that still mention it.
      const found = ids.length ? (await tx(`SELECT i.id,i.deleted_at IS NOT NULL AS trashed,
        EXISTS(SELECT 1 FROM image_references r WHERE r.image_id=i.id AND r.resource_kind=$2 AND r.resource_id=$3) AS referenced
        FROM images i WHERE i.id=ANY($1::uuid[]) ORDER BY i.id FOR KEY SHARE OF i`, [ids, kind, id])).rows : []
      // Check every reference before creating any grant. Guessing an ID is insufficient, and a
      // trashed image keeps only the references it already had.
      for (const image of found) {
        await content(image.id, user, tx)
        if (image.trashed && !image.referenced) error(404, 'Imagen no encontrada')
      }
      await recordImageReferences(tx, kind, id, found.map(image => image.id))
    },
    async list(user) { return (await images.list(user)).map(image => ({ ...image, url: `/api/images/${image.id}/content` })) },
    async page(user, query) {
      const input = pageInput(query)
      const page = await images.page(user, input)
      return pageResult(page.rows, input.limit, image => ({ ...image, url: `/api/images/${image.id}/content` }), page.more)
    },
    async create(user, input) {
      requireEdit(user)
      const scope = input.scope ?? 'personal'
      if (!['personal', 'catalog'].includes(scope)) error(400, 'Ámbito de imagen inválido')
      if (scope === 'catalog') requireAdmin(user)
      const name = requiredText(input.name, 'Nombre').slice(0, 120), mime = String(input.mime || '')
      const bytes = await normalizeImage(mime, imageBytes(mime, input.data)), id = crypto.randomUUID(), ownerId = scope === 'personal' ? user.id : null
      const write = tx => images.create(id, name, mime, bytes, user.id, ownerId, scope, tx)
      if (storage) await storage.create(ownerId, bytes.length, write)
      else await write()
      return { id, name, mime, scope, owner_id: ownerId, url: `/api/images/${id}/content` }
    },
  }
}
