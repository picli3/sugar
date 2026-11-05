import crypto from 'node:crypto'
const fail = (status, message, retryAfter) => { throw Object.assign(new Error(message), { status, retryAfter }) }
export const defaultQuotas = { periodHours: 24, userRequests: 100, globalRequests: 1000, userTokens: 1000000, globalTokens: 10000000, maxConcurrent: 4 }
export function validateQuotas(input) {
  const result = {}
  for (const key of Object.keys(defaultQuotas)) {
    const value = input?.[key], minimum = ['periodHours','maxConcurrent'].includes(key) ? 1 : 0, maximum = key === 'periodHours' ? 744 : key === 'maxConcurrent' ? 32 : 1000000000
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(400, 'aiInvalidQuota')
    result[key] = value
  }
  return result
}
// Conservative byte-based input allowance, protocol overhead and maximum output.
export const reservedTokens = (messages, maxOutput = 4000) => Buffer.byteLength(JSON.stringify(messages)) + 4096 + maxOutput
export async function initAiQuotas(q) {
  await q('CREATE TABLE IF NOT EXISTS ai_quota_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),value jsonb NOT NULL,version integer NOT NULL DEFAULT 1)')
  await q('INSERT INTO ai_quota_config(id,value) VALUES(true,$1::jsonb) ON CONFLICT(id) DO NOTHING', [JSON.stringify(defaultQuotas)])
  await q(`CREATE TABLE IF NOT EXISTS ai_calls(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id),request_id uuid NOT NULL,project_id uuid REFERENCES projects(id),payload_hash text NOT NULL,status text NOT NULL CHECK(status IN ('reserved','succeeded','failed','uncertain')),reserved_tokens bigint NOT NULL,charged_tokens bigint NOT NULL,analysis_id uuid REFERENCES project_analyses(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_id))`)
  await q('ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS storage_bytes bigint NOT NULL DEFAULT 0 CHECK(storage_bytes>=0)')
  // Count previously saved analyses too; their YAML and reported usage remain intact.
  await q(`INSERT INTO ai_calls(id,user_id,request_id,project_id,payload_hash,status,reserved_tokens,charged_tokens,analysis_id,created_at) SELECT a.id,a.author_id,a.request_id,a.project_id,'legacy:'||a.snapshot_hash,'succeeded',212896,CASE WHEN (a.usage->>'total_tokens') ~ '^[0-9]{1,15}$' THEN (a.usage->>'total_tokens')::bigint ELSE 212896 END,a.id,a.created_at FROM project_analyses a LEFT JOIN ai_calls c ON c.user_id=a.author_id AND c.request_id=a.request_id WHERE c.id IS NULL ON CONFLICT(user_id,request_id) DO NOTHING`)
  await q('CREATE INDEX IF NOT EXISTS ai_calls_period ON ai_calls(created_at,user_id)')
  await q("CREATE INDEX IF NOT EXISTS ai_calls_active ON ai_calls(user_id,created_at) WHERE status='reserved'")
}
export function createAiQuotas({ q, transaction, storage }) {
  const lock = tx => tx("SELECT pg_advisory_xact_lock(hashtext('sugar:ai-budget'))")
  const config = async (tx = q) => { const row = (await tx('SELECT value,version FROM ai_quota_config WHERE id=true')).rows[0]; return { ...row.value, version: row.version } }
  async function summary(userId, tx = q) {
    const limits = await config(tx)
    const start = (await tx('SELECT to_timestamp(floor(extract(epoch FROM now())/($1::int*3600))*($1::int*3600)) AS start', [limits.periodHours])).rows[0].start
    const end = new Date(new Date(start).getTime() + limits.periodHours * 3600000)
    const row = (await tx(`SELECT count(*) AS global_requests,COALESCE(sum(charged_tokens),0) AS global_tokens,count(*) FILTER(WHERE user_id=$1) AS user_requests,COALESCE(sum(charged_tokens) FILTER(WHERE user_id=$1),0) AS user_tokens FROM ai_calls WHERE created_at >= $2 AND created_at < $3`, [userId, start, end])).rows[0]
    return { limits, resetsAt: end.toISOString(), user: { requests: Number(row.user_requests), tokens: Number(row.user_tokens) }, platform: { requests: Number(row.global_requests), tokens: Number(row.global_tokens) } }
  }
  return {
    config,
    summary,
    async configure(input) {
      const limits = validateQuotas(input)
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail(400, 'aiInvalidQuota')
      return transaction(async tx => {
        await lock(tx)
        const saved = await tx('UPDATE ai_quota_config SET value=$1::jsonb,version=version+1 WHERE id=true AND version=$2 RETURNING version', [JSON.stringify(limits), input.expectedVersion])
        if (!saved.rowCount) fail(409, 'aiQuotaConflict')
        return { ...limits, version: saved.rows[0].version }
      })
    },
    async reserve(userId, requestId, hash, tokens, projectId = null, storagePlan = null) {
      if (!Number.isSafeInteger(tokens) || tokens < 1) fail(400, 'aiInvalidRequest')
      return transaction(async tx => {
        await lock(tx)
        // Crashed workers leave a debit, never an automatically retryable request.
        await tx("UPDATE ai_calls SET status='uncertain' WHERE status='reserved' AND created_at<now()-interval '5 minutes'")
        const existing = (await tx('SELECT * FROM ai_calls WHERE user_id=$1 AND request_id=$2', [userId, requestId])).rows[0]
        if (existing) {
          if (existing.payload_hash !== hash || existing.project_id !== projectId) fail(409, 'aiInvalidRequest')
          if (existing.status === 'succeeded') return { id: existing.id, replay: true, analysisId: existing.analysis_id }
          fail(409, existing.status === 'reserved' ? 'aiInProgress' : 'aiRequestUsed')
        }
        const active = (await tx("SELECT count(*) AS total,count(*) FILTER(WHERE user_id=$1) AS own FROM ai_calls WHERE status='reserved'", [userId])).rows[0]
        if (Number(active.own)) fail(409, 'aiInProgress')
        const usage = await summary(userId, tx), limits = usage.limits
        if (Number(active.total) >= limits.maxConcurrent) fail(429, 'aiGlobalBusy', 5)
        const wait = Math.max(1, Math.ceil((new Date(usage.resetsAt).getTime() - Date.now()) / 1000))
        if (usage.user.requests + 1 > limits.userRequests || usage.user.tokens + tokens > limits.userTokens) fail(429, 'aiUserQuota', wait)
        if (usage.platform.requests + 1 > limits.globalRequests || usage.platform.tokens + tokens > limits.globalTokens) fail(429, 'aiGlobalQuota', wait)
        const id = crypto.randomUUID()
        await tx("INSERT INTO ai_calls(id,user_id,request_id,project_id,payload_hash,status,reserved_tokens,charged_tokens) VALUES($1,$2,$3,$4,$5,'reserved',$6,$6)", [id, userId, requestId, projectId, hash, tokens])
        if (storage) await storage.reserve(tx, { id, userId, projectId, plan: storagePlan })
        return { id, replay: false }
      })
    },
    async settle(id, usage, save = async () => null) {
      return transaction(async tx => {
        await lock(tx)
        const row = (await tx('SELECT * FROM ai_calls WHERE id=$1 FOR UPDATE', [id])).rows[0]
        if (!row || !['reserved','uncertain'].includes(row.status)) fail(409, 'aiRequestUsed')
        const total = usage?.total_tokens, charged = Number.isSafeInteger(total) && total >= 0 ? total : Number(row.reserved_tokens)
        const analysisId = storage ? await storage.finish(tx, row, save) : await save(tx)
        await tx("UPDATE ai_calls SET status='succeeded',charged_tokens=$2,analysis_id=$3 WHERE id=$1", [id, charged, analysisId])
        return analysisId
      })
    },
    async abandon(id) {
      await transaction(async tx => {
        await lock(tx)
        const row = (await tx('SELECT status FROM ai_calls WHERE id=$1 FOR UPDATE', [id])).rows[0]
        if (!row || !['reserved','uncertain'].includes(row.status)) return
        if (storage) await storage.release(tx, id)
        await tx("UPDATE ai_calls SET status='failed' WHERE id=$1", [id])
      })
    },
  }
}
