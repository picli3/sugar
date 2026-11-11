import { pageInput, pageResult } from '../shared/pagination.js'

export function projectPageInput(query = {}) {
  const favorite = typeof query.cursor === 'string' && query.cursor.startsWith('f_')
  const input = pageInput(favorite ? { ...query, cursor: query.cursor.slice(2) } : query)
  if (favorite) input.after.favorite = true
  return input
}

export function projectPageResult(rows, limit, serialize, more) {
  const result = pageResult(rows, limit, serialize, more)
  if (result.nextCursor && result.items.at(-1).favorite) result.nextCursor = 'f_' + result.nextCursor
  return result
}

export async function initProjectPaginationDb(q) {
  await q(`CREATE TABLE IF NOT EXISTS project_favorites (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id,project_id)
  )`)
  await q('CREATE INDEX IF NOT EXISTS project_favorites_project ON project_favorites(project_id)')
  await q('CREATE INDEX IF NOT EXISTS projects_page_all ON projects(created_at DESC,id DESC) WHERE deleted_at IS NULL')
  await q('CREATE INDEX IF NOT EXISTS projects_page_owner ON projects(created_by,created_at DESC,id DESC) WHERE deleted_at IS NULL')
  await q("CREATE INDEX IF NOT EXISTS projects_page_public ON projects(created_at DESC,id DESC) WHERE deleted_at IS NULL AND visibility='public'")
}
