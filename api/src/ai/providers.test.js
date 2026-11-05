import test from 'node:test'
import assert from 'node:assert/strict'
import { providerIds, providerRequest, providerResult, providers } from './providers.js'
import { encryptToken, decryptToken, updateConfig, publicConfig, callConfiguredProvider } from '../ai.js'
import { analysisAuthor } from './history.js'

process.env.AI_ENCRYPTION_KEY ||= 'a'.repeat(64)
const messages = [{ role: 'system', content: 'Rules' }, { role: 'user', content: 'Review' }]

test('the eight requested providers plus DeepSeek are available over HTTPS', () => {
  assert.deepEqual(providerIds.sort(), ['claude', 'deepseek', 'gemini', 'grok', 'kimi', 'minimax', 'openai', 'openrouter', 'zai'])
  for (const id of providerIds) assert.match(providers[id].url, /^https:\/\/[a-z0-9.-]+\//)
})
test('OpenAI-compatible requests use bearer auth and the provider token parameter', () => {
  const openai = providerRequest('openai', 'm', 'secret', messages, 50)
  assert.equal(openai.headers.Authorization, 'Bearer secret'); assert.equal(openai.body.max_completion_tokens, 50); assert.equal('max_tokens' in openai.body, false)
  const kimi = providerRequest('kimi', 'm', 'secret', messages, 50)
  assert.equal(kimi.body.max_tokens, 50); assert.deepEqual(kimi.body.messages, messages); assert.equal(kimi.body.stream, false)
  assert.deepEqual(providerRequest('deepseek', 'm', 's', messages, 5).body.thinking, { type: 'disabled' })
  assert.equal('thinking' in kimi.body, false)
})
test('Claude requests use x-api-key, the version header and a separate system prompt', () => {
  const claude = providerRequest('claude', 'claude-model', 'secret', messages, 50)
  assert.equal(claude.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(claude.headers['x-api-key'], 'secret'); assert.equal(claude.headers['anthropic-version'], '2023-06-01'); assert.equal('Authorization' in claude.headers, false)
  assert.equal(claude.body.system, 'Rules'); assert.deepEqual(claude.body.messages, [{ role: 'user', content: 'Review' }]); assert.equal(claude.body.max_tokens, 50)
})
test('responses are normalized to text and OpenAI-style usage', () => {
  assert.deepEqual(providerResult('claude', { content: [{ type: 'text', text: 'Hola' }, { type: 'tool_use' }], usage: { input_tokens: 3, output_tokens: 4 }, stop_reason: 'end_turn' }),
    { response: 'Hola', usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }, truncated: false })
  assert.equal(providerResult('claude', { content: [], stop_reason: 'max_tokens' }).truncated, true)
  assert.equal(providerResult('grok', { choices: [{ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }, finish_reason: 'stop' }] }).response, 'AB')
  assert.equal(providerResult('openai', { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }).truncated, true)
})
test('switching provider never reuses the previous provider key', () => {
  const old = { provider: 'deepseek', model: 'deepseek-flash', enabled: true, token: encryptToken('deepseek-key') }
  assert.throws(() => updateConfig(old, { provider: 'claude', model: 'claude-x', enabled: true, token: '' }), /aiNoToken/)
  assert.equal(updateConfig(old, { provider: 'claude', model: 'claude-x', enabled: false, token: '' }).token, null)
  assert.equal(decryptToken(updateConfig(old, { provider: 'claude', model: 'claude-x', enabled: true, token: 'claude-key' }).token), 'claude-key')
  assert.throws(() => updateConfig(old, { provider: 'unknown', model: 'm', enabled: false }), /aiInvalidConfig/)
  const shown = publicConfig({ provider: 'gemini', model: 'g', token: old.token })
  assert.equal(shown.provider, 'gemini'); assert.equal('token' in shown, false); assert.equal(shown.providers.length, 9)
})
test('the configured provider is called with its own endpoint and key; probes accept truncated replies', async () => {
  const config = { provider: 'zai', model: 'glm', token: encryptToken('zai-key') }
  let seen
  const ok = await callConfiguredProvider(config, messages, { fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: 'Bien' }, finish_reason: 'stop' }], usage: { total_tokens: 9 } }), { status: 200, headers: { 'content-type': 'application/json' } }) } })
  assert.equal(seen.url, 'https://api.z.ai/api/paas/v4/chat/completions'); assert.equal(seen.init.headers.Authorization, 'Bearer zai-key'); assert.equal(ok.response, 'Bien')
  const truncated = async () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { total_tokens: 16 } }), { status: 200 })
  await assert.rejects(callConfiguredProvider(config, messages, { fetchImpl: truncated }), /aiOutputLimit/)
  assert.equal((await callConfiguredProvider(config, messages, { fetchImpl: truncated, probe: true, maxTokens: 16 })).response, 'OK')
  await assert.rejects(callConfiguredProvider(config, messages, { fetchImpl: async () => new Response('{}', { status: 403 }) }), /aiInvalidToken/)
})
test('analyses hide provider and model from everyone but Admin', () => {
  const row = { id: 'a', author_id: 'u', author_name: 'Ana', author_email: 'a@x', provider: 'claude', model: 'm', action: 'analyze' }
  const user = analysisAuthor(row, { id: 'u', role: 'dev' }), admin = analysisAuthor(row, { id: 'z', role: 'Admin' })
  assert.equal('provider' in user || 'model' in user, false); assert.equal(user.author, 'Ana')
  assert.equal(admin.provider, 'claude'); assert.equal(admin.model, 'm')
})
