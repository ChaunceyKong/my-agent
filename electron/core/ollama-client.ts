/** Local Ollama only: remote proxy models cannot use the local consent exemption. */
export function ollamaRoot(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('Ollama 地址须为本机 HTTP 服务')
  return url.origin
}

function localModel(name: string, data: Record<string, unknown>): void {
  if (!name.trim() || name.length > 200 || /(?:^|[-:])cloud(?:$|[-:])/i.test(name)
    || data.remote_host || data.remote_model) throw new Error('仅支持本机 Ollama 模型')
}

async function json(fetchImpl: typeof fetch, url: string, signal: AbortSignal, body?: object): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', signal, redirect: 'error',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  if (!response.ok || !response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') { await response.body?.cancel(); throw new Error('Ollama 响应无效') }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []; let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break
      size += value.byteLength; if (size > 262144) throw new Error('Ollama 响应过长'); chunks.push(value)
    }
    signal.throwIfAborted()
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ollama 响应无效')
    return value as Record<string, unknown>
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function discoverOllama(fetchImpl: typeof fetch, baseUrl: string, signal: AbortSignal): Promise<string[]> {
  const data = await json(fetchImpl, `${ollamaRoot(baseUrl)}/api/tags`, signal)
  if (!Array.isArray(data.models) || data.models.length > 500) throw new Error('Ollama 模型列表无效')
  return data.models.flatMap((model) => {
    if (!model || typeof model !== 'object' || typeof model.name !== 'string') throw new Error('Ollama 模型列表无效')
    try { localModel(model.name, model); return [model.name] } catch { return [] }
  })
}

export async function verifyOllama(fetchImpl: typeof fetch, baseUrl: string, name: string, tools: boolean, signal: AbortSignal): Promise<boolean> {
  localModel(name, {})
  const data = await json(fetchImpl, `${ollamaRoot(baseUrl)}/api/show`, signal, { model: name })
  localModel(name, data)
  if (!Array.isArray(data.capabilities) || !data.capabilities.includes('completion') || (tools && !data.capabilities.includes('tools'))) throw new Error(tools ? 'Ollama 模型不支持原生工具调用' : 'Ollama 模型不支持对话')
  return data.capabilities.includes('tools')
}
