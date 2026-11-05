import { error } from '../shared/http.js'
import { pageInput, pageResult } from '../shared/pagination.js'
import { boundedMetadataPage } from '../shared/legacy-list.js'

export const analysisFields = 'a.id,a.project_id,a.author_id,u.email AS author,a.snapshot_hash,a.base_revision,a.action,a.focus,a.language,a.provider,a.model,a.usage,a.created_at'
const textFields = ['author','snapshot_hash','action','focus','language','provider','model','usage']
export function createAnalysisHistory(query) {
  const read = (id, limit, tail, args) => boundedMetadataPage(query,
    `SELECT ${analysisFields},to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM project_analyses a JOIN users u ON u.id=a.author_id WHERE a.project_id=$1 ${tail}`,
    [id, ...args], { order: 'r.created_at DESC,r.id DESC', textFields, limit })
  return {
    async page(id, query) {
      const input = pageInput(query), { after, limit } = input
      const result = await read(id, limit, `AND ($2::timestamptz IS NULL OR (a.created_at,a.id)<($2::timestamptz,$3::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT $4`, [after?.at ?? null, after?.id ?? null, limit + 1])
      return pageResult(result.rows, limit, item => item, result.more)
    },
    async legacy(id, query = {}) {
      const value = query.offset
      if (Object.keys(query).some(key => key !== 'offset') || (value !== undefined && (typeof value !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(value) || Number(value) > 1000))) error(400, 'Paginación antigua limitada a offset 1000; usa /analyses/page / Legacy pagination limited to offset 1000; use /analyses/page')
      const offset = Number(value || 0)
      const result = await read(id, 20, 'ORDER BY a.created_at DESC,a.id DESC LIMIT 21 OFFSET $2', [offset])
      if (result.more && offset + result.rows.length > 1000) error(413, 'Historial antiguo demasiado grande; usa /analyses/page / Legacy history too large; use /analyses/page')
      return { items: result.rows.map(({ cursor_time, ...row }) => row), nextOffset: result.more ? offset + result.rows.length : null }
    },
  }
}
