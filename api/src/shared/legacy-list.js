import { error } from './http.js'
export const legacyListLimit = 1000, legacyListBytes = 4 * 1024 * 1024
const metadataRows = items => items.map(({ _legacy_id, ...item }) => ({ ...item, ...(item.created_at == null ? {} : { created_at: new Date(item.created_at) }) }))
function metadataBytes(textFields) {
  if (textFields.some(field => !/^[a-z_]+$/.test(field))) throw Error('Invalid metadata field')
  return textFields.map(field => `COALESCE(octet_length(r."${field}"::text),0)::bigint`).join('+') || '0'
}

// SQL/order/field names are repository constants, never request parameters.
// The JSON aggregate is a conditional subquery: oversized rows are not encoded
// into an array before the budget decision. Count/bytes share one DB snapshot.
export async function boundedLegacyList(query, sql, args, { order, textFields }) {
  const bytes = metadataBytes(textFields)
  const result = await query(`WITH legacy_rows AS MATERIALIZED (${sql} LIMIT ${legacyListLimit + 1}),
    budget AS (SELECT count(*) AS total,COALESCE(sum(${bytes}),0) AS bytes FROM legacy_rows r)
    SELECT total,bytes,CASE WHEN total<=${legacyListLimit} AND bytes<=${legacyListBytes}
      THEN (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY ${order}),'[]'::jsonb) FROM legacy_rows r)
      ELSE NULL END AS items FROM budget`, args)
  const row = result.rows[0]
  if (BigInt(row.total) > BigInt(legacyListLimit) || BigInt(row.bytes) > BigInt(legacyListBytes)) error(413, 'Listado antiguo demasiado grande; actualiza el cliente y usa las páginas / Legacy list too large; update the client and use pages')
  return metadataRows(row.items)
}

// The source query must already cap its candidates at limit+1. Large legacy
// metadata can shorten a page, but a record is always returned whole or rejected.
export async function boundedMetadataPage(query, sql, args, { order, textFields, limit }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid metadata page limit')
  const bytes = metadataBytes(textFields)
  const result = await query(`WITH metadata_source AS MATERIALIZED (${sql}), metadata_rows AS (
      SELECT r.*,row_number() OVER(ORDER BY ${order}) AS _page_row,
        sum(${bytes}) OVER(ORDER BY ${order}) AS _page_bytes FROM metadata_source r
    ), budget AS (SELECT count(*) AS total,count(*) FILTER(WHERE _page_row<=${limit} AND _page_bytes<=${legacyListBytes}) AS accepted FROM metadata_rows)
    SELECT total>accepted AS more,total>0 AND accepted=0 AS oversized,
      (SELECT COALESCE(jsonb_agg(to_jsonb(p)-'_page_row'-'_page_bytes' ORDER BY _page_row),'[]'::jsonb)
       FROM metadata_rows p WHERE _page_row<=${limit} AND _page_bytes<=${legacyListBytes}) AS items FROM budget`, args)
  const row = result.rows[0]
  if (row.oversized) error(413, 'Metadata antigua supera 4 MiB; reduce el registro antes de listar / Legacy metadata exceeds 4 MiB; reduce the record before listing')
  return { rows: metadataRows(row.items), more: row.more }
}
