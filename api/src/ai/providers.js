// AI providers an Admin can choose (#30). Endpoints verified against provider documentation on
// 5 November 2026. Most expose OpenAI-compatible chat completions; Claude uses Anthropic Messages.
// Model IDs are typed by the Admin: catalogs change too often to hardcode.
export const providers = Object.freeze({
  deepseek: { label: 'DeepSeek', protocol: 'openai', url: 'https://api.deepseek.com/chat/completions', tokenParam: 'max_tokens', extra: { thinking: { type: 'disabled' } }, defaultModel: 'deepseek-flash' },
  openai: { label: 'OpenAI', protocol: 'openai', url: 'https://api.openai.com/v1/chat/completions', tokenParam: 'max_completion_tokens' },
  claude: { label: 'Claude (Anthropic)', protocol: 'anthropic', url: 'https://api.anthropic.com/v1/messages' },
  gemini: { label: 'Google Gemini', protocol: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', tokenParam: 'max_tokens' },
  openrouter: { label: 'OpenRouter', protocol: 'openai', url: 'https://openrouter.ai/api/v1/chat/completions', tokenParam: 'max_tokens' },
  kimi: { label: 'Kimi (Moonshot)', protocol: 'openai', url: 'https://api.moonshot.ai/v1/chat/completions', tokenParam: 'max_tokens' },
  zai: { label: 'Z.ai (GLM)', protocol: 'openai', url: 'https://api.z.ai/api/paas/v4/chat/completions', tokenParam: 'max_tokens' },
  grok: { label: 'Grok (xAI)', protocol: 'openai', url: 'https://api.x.ai/v1/chat/completions', tokenParam: 'max_tokens' },
  minimax: { label: 'MiniMax', protocol: 'openai', url: 'https://api.minimax.io/v1/chat/completions', tokenParam: 'max_completion_tokens' },
})
export const providerIds = Object.keys(providers)
// Letters, digits and the separators real model IDs use (e.g. "vendor/model:variant").
export const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
export const providerList = () => providerIds.map(id => ({ id, label: providers[id].label, defaultModel: providers[id].defaultModel || '' }))

const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : undefined

// Builds the HTTP request for a provider; the token never leaves this function except in headers.
export function providerRequest(id, model, token, messages, maxTokens) {
  const provider = providers[id]
  if (!provider) throw Object.assign(new Error('aiInvalidConfig'), { status: 503 })
  if (provider.protocol === 'anthropic') {
    const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
    return { url: provider.url, headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: messages.filter(message => message.role !== 'system') } }
  }
  return { url: provider.url, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: { model, messages, [provider.tokenParam]: maxTokens, stream: false, ...(provider.extra || {}) } }
}

// Normalizes a provider response to { response, usage, truncated } with OpenAI-style usage keys.
export function providerResult(id, body) {
  if (providers[id]?.protocol === 'anthropic') {
    const input = body?.usage?.input_tokens, output = body?.usage?.output_tokens
    const usage = Number.isSafeInteger(input) && Number.isSafeInteger(output) ? { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } : undefined
    return { response: text(body?.content), usage, truncated: body?.stop_reason === 'max_tokens' }
  }
  const choice = body?.choices?.[0]
  return { response: text(choice?.message?.content), usage: body?.usage, truncated: choice?.finish_reason === 'length' }
}
