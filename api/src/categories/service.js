import { error } from '../shared/http.js'
import { identifierPageInput, identifierPageResult } from '../shared/pagination.js'
import { libraryPermissions } from '../library/access.js'
const serialize = (row, user) => { const permissions = libraryPermissions(row, user); return { ...row, permissions: { ...permissions, canEdit: !row.deleted_at && permissions.canEdit } } }
export function createCategoryReadService(categories) {
  return {
    async page(user, query) {
      const options = identifierPageInput(query)
      return identifierPageResult(await categories.page(user, options), options.limit, row => serialize(row, user))
    },
    async resolve(user, input) {
      if (!input || Object.keys(input).some(key => key !== 'slugs') || !Array.isArray(input.slugs) || input.slugs.length > 64 || input.slugs.some(slug => typeof slug !== 'string' || Buffer.byteLength(slug) > 256 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) error(400, 'Resuelve hasta 64 categorías por solicitud / Resolve up to 64 categories per request')
      if (!input.slugs.length) return []
      return (await categories.resolve(user, [...new Set(input.slugs)])).map(row => serialize(row, user))
    },
  }
}
