import { person, people } from '../shared/identity.js'
import crypto from 'node:crypto'
import { documentDiff } from '../shared/document-diff.js'
import { error, requiredText } from '../shared/http.js'
import { libraryOwner, libraryPermissions, requireLibraryAccess } from '../library/access.js'
import { normalizeColorLiterals, stringify, validateBlock, revisionSummary } from '../model.js'
import { readSchematic } from '../schematics/format.js'
import { revisionPageInput, revisionPageResult, identifierPageInput } from '../shared/pagination.js'

export function createBlockService({ blocks, transaction, storage, validateCategory, replaceEmbeddedImages, attachImages = async () => {}, schematics }) {
  const get = async (id, user, edit = false, tx, lock = false) => requireLibraryAccess(await blocks.find(id, tx, lock), user, edit)
  const write = (id, action) => storage ? storage.write('block', id, action) : transaction(action)
  async function attachSchematic(tx, yaml, block, id, user, upload) {
    let createdId
    if (upload) {
      const stored = await schematics.store(tx, upload)
      createdId = stored.id
      block.design_block_kicad = stored.url
      yaml = stringify(block)
      validateBlock(yaml)
    }
    await schematics?.attach(block, 'block', id, user, tx, createdId)
    return yaml
  }
  const loadPage = async (user, options) => {
    const rows = await blocks.page(user, options)
    if (rows.some(row => row.page_oversized)) error(413, 'Un bloque antiguo supera 4 MiB de YAML/nombre; reduce su contenido antes de listar / A legacy block exceeds 4 MiB of YAML/name; reduce its content before listing')
    return {
      items: rows.map(({ page_more, page_oversized, ...block }) => ({ ...block, permissions: libraryPermissions(block, user) })),
      nextCursor: rows[0]?.page_more ? rows.at(-1).id : null,
    }
  }
  return {
    async list(user) {
      const page = await loadPage(user, { limit: 100, after: null, nameOrder: true })
      if (page.nextCursor) error(413, 'Listado antiguo demasiado grande; usa la biblioteca paginada / Legacy listing too large; use the paginated library')
      return page.items
    },
    page: (user, query) => loadPage(user, identifierPageInput(query)),
    // Lets the editor flag instances whose library block has a newer version (#33).
    async latestVersions(user, input) {
      const ids = input?.ids
      if (!Array.isArray(ids) || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) error(400, 'Lista de bloques inválida / Invalid block list')
      if (!ids.length) return { versions: {} }
      return { versions: Object.fromEntries((await blocks.latestVersions(ids, user)).map(row => [row.id, row.latest_version])) }
    },
    async get(id, user) {
      await get(id, user)
      const block = requireLibraryAccess(await blocks.current(id), user)
      return { ...block, permissions: libraryPermissions(block, user) }
    },
    async create(user, input) {
      const ownerId = libraryOwner(user, input.scope)
      const yaml = normalizeColorLiterals(requiredText(input.yaml, 'YAML')), block = validateBlock(yaml), id = crypto.randomUUID(), summary = revisionSummary(input.summary, 'Bloque creado')
      const upload = input.designBlock === undefined ? null : readSchematic(input.designBlock)
      await write(id, async tx => {
        await validateCategory(block, tx, false, ownerId)
        await blocks.create(id, block, tx, ownerId)
        await attachImages(yaml, 'block', id, user, tx)
        const content = await attachSchematic(tx, yaml, block, id, user, upload)
        await blocks.addVersion(id, 1, content, user.id, summary, tx)
      })
      return { id, version: 1 }
    },
    versions: async (id, user) => { await get(id, user); return people(await blocks.versions(id), user, 'author') },
    async versionsPage(id, user, query) {
      await get(id, user)
      const options = revisionPageInput(query)
      const page = await blocks.versionsPage(id, options)
      return revisionPageResult(people(page.rows, user, 'author'), options.limit, 'version', page.more)
    },
    async version(id, version, user) {
      await get(id, user)
      const saved = await blocks.version(id, version)
      if (!saved) error(404, 'Versión no encontrada')
      return saved.yaml
    },
    async diff(id, input, user) {
      await get(id, user)
      const a = Number(input.from), b = Number(input.to)
      if (!Number.isInteger(a) || !Number.isInteger(b)) error(400, 'Selecciona dos versiones')
      const rows = await blocks.comparison(id, a, b)
      const one = rows.find(r => r.version === a), two = rows.find(r => r.version === b)
      if (!one || !two) error(404, 'Versión no encontrada')
      return documentDiff('block.yaml', one.yaml, two.yaml, `version ${a}`, `version ${b}`)
    },
    async restore(id, user, input) {
      await get(id, user, true)
      const wanted = Number(input.version), expected = Number(input.expectedVersion)
      if (!Number.isInteger(wanted) || !Number.isInteger(expected)) error(400, 'Versión inválida')
      const source = await blocks.version(id, wanted)
      if (!source) error(404, 'Versión no encontrada')
      const version = await write(id, async tx => {
        const current = await get(id, user, true, tx, true)
        let yaml = normalizeColorLiterals(await replaceEmbeddedImages(source.yaml, 'block', tx, { ownerId: current.owner_id, catalog: !current.owner_id }))
        let block = validateBlock(yaml)
        if (input.category) {
          block.category = input.category
          if (input.subcategory) block.subcategory = input.subcategory
          else delete block.subcategory
          yaml = stringify(block)
          block = validateBlock(yaml)
        }
        await validateCategory(block, tx, !block.category, current.owner_id)
        const saved = await blocks.save(id, expected, block, tx)
        if (!saved) error(409, 'El bloque cambió; recarga antes de restaurar')
        const version = saved.latest_version
        await attachImages(yaml, 'block', id, user, tx)
        await attachSchematic(tx, yaml, block, id, user)
        await blocks.addVersion(id, version, yaml, user.id, `Restaurada versión ${wanted}`, tx)
        return version
      })
      return { version }
    },
    async save(id, user, input) {
      await get(id, user, true)
      const yaml = normalizeColorLiterals(requiredText(input.yaml, 'YAML')), block = validateBlock(yaml), expected = Number(input.expectedVersion)
      if (!Number.isInteger(expected) || expected < 1) error(400, 'Versión esperada inválida')
      const summary = revisionSummary(input.summary, 'Bloque actualizado')
      const upload = input.designBlock === undefined ? null : readSchematic(input.designBlock)
      const version = await write(id, async tx => {
        const current = await get(id, user, true, tx, true)
        await validateCategory(block, tx, false, current.owner_id)
        const saved = await blocks.save(id, expected, block, tx)
        if (!saved) error(409, 'El bloque cambió; recarga antes de guardar')
        const version = saved.latest_version
        await attachImages(yaml, 'block', id, user, tx)
        const content = await attachSchematic(tx, yaml, block, id, user, upload)
        await blocks.addVersion(id, version, content, user.id, summary, tx)
        return version
      })
      return { version }
    },
  }
}
