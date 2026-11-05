import { error } from './http.js'
export const legacyListLimit = 1000, legacyListBytes = 4 * 1024 * 1024

// SQL/order/field names are repository constants, never request parameters.
// The JSON aggregate is a conditional subquery: oversized rows are not encoded
// into an array before the budget decision. Count/bytes share one DB snapshot.
export async function boundedLegacyList(query, sql, args, { order, textFields }) {
  if (textFields.some(field => !/^[a-z_]+$/.test(field))) throw Error('Invalid legacy metadata field')
  const bytes = textFields.map(field => `COALESCE(octet_length(r."${field}"::text),0)::bigint`).join('+') || '0'
  const result = await query(`WITH legacy_rows AS MATERIALIZED (${sql} LIMIT ${legacyListLimit + 1}),
    budget AS (SELECT count(*) AS total,COALESCE(sum(${bytes}),0) AS bytes FROM legacy_rows r)
    SELECT total,bytes,CASE WHEN total<=${legacyListLimit} AND bytes<=${legacyListBytes}
      THEN (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY ${order}),'[]'::jsonb) FROM legacy_rows r)
      ELSE NULL END AS items FROM budget`, args)
  const row = result.rows[0]
  if (BigInt(row.total) > BigInt(legacyListLimit) || BigInt(row.bytes) > BigInt(legacyListBytes)) error(413, 'Listado antiguo demasiado grande; actualiza el cliente y usa las páginas / Legacy list too large; update the client and use pages')
  return row.items.map(({ _legacy_id, ...item }) => ({ ...item, ...(item.created_at == null ? {} : { created_at: new Date(item.created_at) }) }))
}
