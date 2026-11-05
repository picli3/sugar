import { error } from '../shared/http.js'
import { requireEdit } from '../auth/policies.js'
import { pageInput, pageResult } from '../shared/pagination.js'
import { trashKinds, trashRetentionDays } from './repository.js'

const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
const labels = { project: 'Proyecto no encontrado / Project not found', block: 'Bloque no encontrado / Block not found', image: 'Imagen no encontrada / Image not found' }

// Owners manage their own resources; Admin manages everything, including the shared catalog.
// Anything the caller cannot manage is reported as missing, never as someone else's resource.
export function createTrashService({ trash, transaction }) {
  const kindOf = kind => { if (!trashKinds.includes(kind)) error(404, 'Tipo no admitido / Unsupported kind'); return kind }
  const manageable = async (kind, id, user, tx, lock) => {
    requireEdit(user)
    const item = validId(id) && await trash.find(kind, id, tx, lock)
    if (!item || (user.role !== 'Admin' && item.owner_id !== user.id)) error(404, labels[kind])
    return item
  }
  const view = ({ cursor_time, ...item }) => ({ ...item, retentionDays: trashRetentionDays })
  return {
    retentionDays: trashRetentionDays,
    async trash(kind, id, user) {
      kindOf(kind)
      await transaction(async tx => {
        const item = await manageable(kind, id, user, tx, true)
        if (item.deleted_at) error(404, labels[kind])
        await trash.trash(kind, id, tx)
      })
    },
    async page(user, query) {
      requireEdit(user)
      const input = pageInput(query)
      return pageResult(await trash.page(user, input), input.limit, item => view(item))
    },
    async restore(kind, id, user) {
      kindOf(kind)
      return transaction(async tx => {
        const item = await manageable(kind, id, user, tx, true)
        if (!item.deleted_at) error(409, 'El recurso no está en la papelera / Resource is not in the trash')
        await trash.restore(kind, id, tx)
        return { kind, id, name: item.name }
      })
    },
    async purge(kind, id, user, input = {}) {
      kindOf(kind)
      return transaction(async tx => {
        const item = await manageable(kind, id, user, tx, true)
        if (!item.deleted_at) error(409, 'Envía el recurso a la papelera antes de eliminarlo definitivamente / Move the resource to the trash before deleting it permanently')
        if (!item.purgeable) error(409, `Se puede eliminar definitivamente después de ${trashRetentionDays} días en la papelera (${item.purge_after}) / Permanent deletion is available after ${trashRetentionDays} days in the trash (${item.purge_after})`)
        if (typeof input.confirm !== 'string' || input.confirm !== item.name) error(400, 'Escribe el nombre exacto para confirmar la eliminación definitiva / Type the exact name to confirm permanent deletion')
        if (!(await trash.purge(kind, id, tx))) error(409, 'El recurso cambió; recarga la papelera / Resource changed; reload the trash')
        return { kind, id, purged: true }
      })
    },
  }
}
