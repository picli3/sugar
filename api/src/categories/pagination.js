export async function initCategoryPaginationDb(q) {
  await q('CREATE INDEX IF NOT EXISTS categories_page_all ON block_categories(id) WHERE deleted_at IS NULL')
  await q('CREATE INDEX IF NOT EXISTS categories_page_owner ON block_categories(owner_id,id) WHERE deleted_at IS NULL')
  await q('CREATE INDEX IF NOT EXISTS categories_page_catalog ON block_categories(id) WHERE deleted_at IS NULL AND owner_id IS NULL')
}
