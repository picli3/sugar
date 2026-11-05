import { personColumns, personTextFields } from '../shared/identity.js'
import { boundedLegacyList, boundedMetadataPage } from '../shared/legacy-list.js'
import { libraryPageBytes } from './pagination.js'
export function createBlockRepository(query) {
  return {
    async page(user, { limit, after, nameOrder = false }) {
      const args = [], bind = value => { args.push(value); return '$' + args.length }
      const boundary = after ? `AND b.id>${bind(after)}::uuid` : '', cap = bind(limit + 1)
      const order = nameOrder ? 'b.name,b.id' : 'b.id', windowOrder = nameOrder ? 'name,id' : 'id'
      const branch = filter => `(SELECT b.id,b.name,b.latest_version,b.owner_id FROM blocks b
        WHERE b.deleted_at IS NULL AND EXISTS(SELECT 1 FROM block_versions v WHERE v.block_id=b.id AND v.version=b.latest_version)
        ${filter} ${boundary} ORDER BY ${order} LIMIT ${cap})`
      const candidates = user.role === 'Admin' ? branch('') : branch(`AND b.owner_id=${bind(user.id)}::uuid`) + ' UNION ALL ' + branch('AND b.owner_id IS NULL')
      const visible = bind(limit)
      return (await query(`WITH candidates AS (
        SELECT b.* FROM (${candidates}) b ORDER BY ${order} LIMIT ${cap}
      ), measured AS (
        SELECT b.*,v.yaml,v.created_at FROM candidates b JOIN block_versions v ON v.block_id=b.id AND v.version=b.latest_version
      ), prefix AS (
        SELECT measured.*,row_number() OVER(ORDER BY ${windowOrder}) AS n,
          sum(octet_length(yaml)::bigint+octet_length(name)) OVER(ORDER BY ${windowOrder}) AS page_bytes FROM measured
      ), budget AS (
        SELECT count(*) AS total,count(*) FILTER(WHERE n<=${visible} AND page_bytes<=${libraryPageBytes}) AS accepted FROM prefix
      )
      SELECT c.id,c.name,c.latest_version,c.owner_id,c.yaml,c.created_at,b.accepted<b.total AS page_more,false AS page_oversized
        FROM prefix c CROSS JOIN budget b WHERE c.n<=${visible} AND c.page_bytes<=${libraryPageBytes}
      UNION ALL SELECT c.id,NULL,NULL,NULL,NULL,NULL,false,true FROM prefix c CROSS JOIN budget b WHERE b.accepted=0 AND c.n=1
      ORDER BY ${nameOrder ? 'name,id' : 'id'}`, args)).rows
    },
    async current(id) {
      return (await query(`SELECT b.id,b.name,b.latest_version,b.owner_id,v.yaml,v.created_at
        FROM blocks b JOIN block_versions v ON v.block_id=b.id AND v.version=b.latest_version
        WHERE b.id=$1 AND b.deleted_at IS NULL`, [id])).rows[0]
    },
    async find(id, execute = query, lock = false) {
      return (await execute(`SELECT id,owner_id FROM blocks WHERE id=$1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]
    },
    async create(id, block, tx, ownerId) {
      await tx('INSERT INTO blocks(id,name,latest_version,category_slug,subcategory_slug,owner_id) VALUES($1,$2,1,$3,$4,$5)', [id, block.name, block.category, block.subcategory || null, ownerId])
    },
    async addVersion(id, version, yaml, authorId, summary, tx) {
      await tx('INSERT INTO block_versions(block_id,version,yaml,author_id,summary) VALUES($1,$2,$3,$4,$5)', [id, version, yaml, authorId, summary])
    },
    async versions(id) {
      return boundedLegacyList(query, `SELECT v.version,v.summary,v.created_at,${personColumns('u', 'v.author_id', 'author')} FROM block_versions v LEFT JOIN users u ON u.id=v.author_id WHERE block_id=$1 ORDER BY version DESC`, [id], { order: 'r.version DESC', textFields: ['summary',...personTextFields('author')] })
    },
    async versionsPage(id, { limit, before }) {
      const args = [id], boundary = before === null ? '' : 'AND v.version<$2::integer'
      if (before !== null) args.push(before)
      args.push(limit + 1)
      return boundedMetadataPage(query, `SELECT v.version,v.summary,v.created_at,${personColumns('u', 'v.author_id', 'author')} FROM block_versions v
        LEFT JOIN users u ON u.id=v.author_id WHERE v.block_id=$1 ${boundary}
        ORDER BY v.version DESC LIMIT $${args.length}`, args, { order: 'r.version DESC', textFields: ['summary', ...personTextFields('author')], limit })
    },
    async version(id, version) {
      return (await query('SELECT yaml FROM block_versions WHERE block_id=$1 AND version=$2', [id, version])).rows[0]
    },
    async comparison(id, from, to) {
      return (await query('SELECT version,yaml FROM block_versions WHERE block_id=$1 AND version=ANY($2::int[])', [id, [from, to]])).rows
    },
    async save(id, expected, block, tx) {
      return (await tx('UPDATE blocks SET name=$3,category_slug=$4,subcategory_slug=$5,latest_version=latest_version+1 WHERE id=$1 AND latest_version=$2 AND deleted_at IS NULL RETURNING latest_version', [id, expected, block.name, block.category || null, block.subcategory || null])).rows[0]
    },
  }
}
