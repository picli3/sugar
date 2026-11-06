import { error } from '../shared/http.js'

// Durable security audit (#23, stage 2b). Rows hold only the closed sugar.audit.v1 fields:
// no IP, email, body, URL, token or error text. Retention is time based and enforced on write.
export const auditRetentionDays = 180
const results = ['success', 'denied', 'error', 'aborted']
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const id = value => typeof value === 'string' && uuid.test(value) ? value : null

export async function initAuditDb(q) {
  await q(`CREATE TABLE IF NOT EXISTS audit_events(id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
    request_id uuid, actor uuid, operation text NOT NULL CHECK(operation ~ '^[a-z]+\\.[a-z_]+$'),
    result text NOT NULL CHECK(result IN ('success','denied','error','aborted')), status smallint CHECK(status BETWEEN 100 AND 599), resource uuid)`)
  await q('CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events(at)')
  await q('CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events(actor,at) WHERE actor IS NOT NULL')
}

export function createAuditStore({ q, retentionDays = auditRetentionDays, purgeEveryMs = 3600_000, clock = () => Date.now() }) {
  let lastPurge = -Infinity
  return {
    async write(event) {
      if (!results.includes(event.result) || !/^[a-z]+\.[a-z_]+$/.test(event.operation)) return
      await q('INSERT INTO audit_events(at,request_id,actor,operation,result,status,resource) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [event.at, id(event.request_id), id(event.actor), event.operation, event.result, Number.isInteger(event.status) ? event.status : null, id(event.resource)])
      if (clock() - lastPurge < purgeEveryMs) return
      lastPurge = clock()
      // Bounded batch so a long backlog never turns one request into a large delete.
      await q(`DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE at < now() - make_interval(days => $1) ORDER BY id LIMIT 5000)`, [retentionDays])
    },
    // Admin listing, newest first, keyset-paginated by id.
    async list(user, { before, limit, result, operation } = {}) {
      if (user?.role !== 'Admin') error(403, 'Se requiere rol Admin')
      const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 100)
      const cursor = before === undefined || before === '' ? null : /^[1-9][0-9]{0,17}$/.test(String(before)) ? String(before) : error(400, 'Cursor inválido')
      const filterResult = result ? (results.includes(result) ? result : error(400, 'Resultado inválido')) : null
      const filterOperation = operation ? (/^[a-z]+(\.[a-z_]+)?$/.test(operation) ? operation : error(400, 'Operación inválida')) : null
      const rows = (await q(`SELECT e.id::text,e.at,e.request_id,e.actor,u.email AS actor_email,e.operation,e.result,e.status,e.resource
        FROM audit_events e LEFT JOIN users u ON u.id=e.actor
        WHERE ($1::bigint IS NULL OR e.id < $1) AND ($2::text IS NULL OR e.result=$2)
          AND ($3::text IS NULL OR e.operation=$3 OR e.operation LIKE $3 || '.%')
        ORDER BY e.id DESC LIMIT $4`, [cursor, filterResult, filterOperation, size + 1])).rows
      return { events: rows.slice(0, size), next: rows.length > size ? rows[size - 1].id : null, retentionDays }
    },
  }
}
