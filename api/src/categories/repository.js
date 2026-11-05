const fields = 'c.id,c.slug,c.name,c.parent_id,c.icon,c.deleted_at,c.owner_id'
export function createCategoryRepository(query) {
  return {
    async page(user, { limit, after }) {
      const args = [], bind = value => { args.push(value); return '$' + args.length }
      const boundary = after ? `AND c.id>${bind(after)}::uuid` : '', cap = bind(limit + 1)
      const branch = filter => `(SELECT ${fields} FROM block_categories c WHERE c.deleted_at IS NULL ${filter} ${boundary} ORDER BY c.id LIMIT ${cap})`
      const candidates = user.role === 'Admin' ? branch('') : branch(`AND c.owner_id=${bind(user.id)}::uuid`) + ' UNION ALL ' + branch('AND c.owner_id IS NULL')
      return (await query(`SELECT * FROM (${candidates}) c ORDER BY c.id LIMIT ${cap}`, args)).rows
    },
    async resolve(user, slugs) {
      return (await query(`WITH selected AS (
        SELECT ${fields} FROM block_categories c WHERE c.slug=ANY($1::text[])
          AND (c.owner_id IS NULL OR c.owner_id=$2 OR $3='Admin')
      ) SELECT * FROM selected UNION
        SELECT ${fields} FROM block_categories c WHERE c.id IN(SELECT parent_id FROM selected)
          AND (c.owner_id IS NULL OR c.owner_id=$2 OR $3='Admin')`, [slugs, user.id, user.role])).rows
    },
  }
}
