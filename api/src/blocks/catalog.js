import { documentLimits, validateBlock } from '../model.js'
import { schematicUrlId } from '../schematics/format.js'

export function catalogPreview(block, version) {
  return {
    version,
    category: block.category || null,
    subcategory: block.subcategory || null,
    model: block.model || '',
    function: block.function || '',
    port_terms: block.ports.flatMap(port => [port.id, port.label, port.protocol]).join(' '),
    image: block.image || null,
    has_schematic: !!schematicUrlId(block.design_block_kicad),
  }
}

export async function migrateBlockCatalog(q, transaction) {
  await q('ALTER TABLE blocks ADD COLUMN IF NOT EXISTS catalog_preview jsonb')
  let after = null
  for (;;) {
    // At most eight source documents of at most two MB each. Oversized legacy
    // YAML stays in version history and never crosses the migration boundary.
    const { rows } = await q(`SELECT b.id,b.latest_version,
      CASE WHEN octet_length(v.yaml)<=$2 THEN v.yaml END AS yaml
      FROM blocks b JOIN block_versions v ON v.block_id=b.id AND v.version=b.latest_version
      WHERE ($1::uuid IS NULL OR b.id>$1)
        AND b.catalog_preview->>'version' IS DISTINCT FROM b.latest_version::text
      ORDER BY b.id LIMIT 8`, [after, documentLimits.yamlBytes])
    if (!rows.length) return
    const previews = rows.map(row => {
      let preview = { version: row.latest_version }
      if (row.yaml) {
        try { preview = catalogPreview(validateBlock(row.yaml), row.latest_version) }
        catch (error) { if (error.status !== 400) throw error }
      }
      return { ...row, preview }
    })
    await transaction(async tx => {
      for (const { id, latest_version, preview } of previews) {
        await tx('UPDATE blocks SET catalog_preview=$3 WHERE id=$1 AND latest_version=$2', [id, latest_version, preview])
      }
    })
    after = rows.at(-1).id
  }
}
