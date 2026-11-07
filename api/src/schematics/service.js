import crypto from 'node:crypto'
import { error } from '../shared/http.js'
import { schematicId, schematicUrl, schematicUrlId } from './format.js'

const missing = () => error(404, 'Esquema KiCad no encontrado / KiCad schematic not found')

export function createSchematicService(repository) {
  return {
    async store(tx, file) {
      const id = crypto.randomUUID()
      await repository.create(tx, id, file)
      return { id, url: schematicUrl(id) }
    },
    async attach(document, kind, resourceId, user, tx, createdId) {
      const blocks = kind === 'project' ? document.nodes.map(node => node.block) : [document]
      const ids = [...new Set(blocks.map(block => schematicUrlId(block.design_block_kicad)).filter(Boolean))]
      if (!await repository.attach(tx, kind, resourceId, ids, user, createdId)) missing()
    },
    async content(id, user) {
      const file = schematicId.test(id) && await repository.content(id, user)
      if (!file) missing()
      return file
    },
    async shared(id, token) {
      const file = schematicId.test(id) && /^[A-Za-z0-9_-]{43}$/.test(token) && await repository.shared(id, token)
      if (!file) missing()
      return file
    },
  }
}
