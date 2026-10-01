import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase } from '../../electron/database/client'
import { createRepositories } from '../../electron/database/repositories'
import { createModelClient } from '../../electron/core/model-client'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { discoverOllama, ollamaRoot, verifyOllama } from '../../electron/core/ollama-client'
import Database from 'better-sqlite3'
import { migrate } from '../../electron/database/schema'

const db = createDatabase({ filePath: ':memory:' })
const repo = createRepositories(db)
const fetchImpl = vi.fn()
const client = createModelClient({ repositories: repo, consent: createCloudConsentService(repo), fetch: fetchImpl,
  crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() },
  taskRuns: { canAcceptChunk: async () => true, onCancelled: () => () => {} } })
const response = (data: object) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => { fetchImpl.mockReset(); vi.useRealTimers() })

it('preserves encrypted key on blank edit, returns no key and clears external consents', async () => {
  const { project } = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: 'C:/test' })
  const model = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'first', apiKey: 'SECRET' })
  await repo.recordCloudConsent(project.id, model.id); await repo.recordToolResultConsent(project.id, model.id, 1)
  const saved = await client.saveModelConfig({ id: model.id, providerPreset: 'openai', modelName: 'second', apiKey: '' })
  expect(saved.id).toBe(model.id); expect(JSON.stringify(saved)).not.toContain('SECRET')
  expect((await repo.getModelConfig(model.id))?.encryptedApiKey).toBe(Buffer.from('SECRET').toString('base64'))
  expect(await repo.hasCloudConsent(project.id, model.id)).toBe(false)
  expect(await repo.hasToolResultConsent(project.id, model.id, 1)).toBe(false)
})

it('changes the model snapshot for each edit even with unchanged values in the same millisecond', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
  const input = { providerPreset: 'openai' as const, modelName: 'test', apiKey: 'SECRET' }
  const model = await client.saveModelConfig(input)
  const original = await repo.getModelConfig(model.id)
  await client.saveModelConfig({ ...input, id: model.id, apiKey: '' })
  const firstEdit = await repo.getModelConfig(model.id)
  await client.saveModelConfig({ ...input, id: model.id, apiKey: '' })
  const secondEdit = await repo.getModelConfig(model.id)
  expect(firstEdit?.updatedAt).toBe('2026-10-01T00:00:00.001Z')
  expect(secondEdit?.updatedAt).toBe('2026-10-01T00:00:00.002Z')
  expect(JSON.stringify(firstEdit)).not.toBe(JSON.stringify(original))
  expect(JSON.stringify(secondEdit)).not.toBe(JSON.stringify(firstEdit))
})

it('uses global scheduler only without override and rejects referenced deletion', async () => {
  const { channel } = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: 'C:/test' })
  const a = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'a', apiKey: 'key' })
  const b = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'b', apiKey: 'key' })
  await repo.setDefaultScheduler(a.id); expect(await repo.getEffectiveScheduler(channel.id)).toBe(a.id)
  await expect(repo.removeModelConfig(a.id)).rejects.toThrow('引用')
  await repo.setChannelScheduler(channel.id, b.id); expect(await repo.getEffectiveScheduler(channel.id)).toBe(b.id)
  await expect(repo.removeModelConfig(b.id)).rejects.toThrow('引用')
  await repo.setChannelScheduler(channel.id, null); expect(await repo.getEffectiveScheduler(channel.id)).toBe(a.id)
  await repo.setDefaultScheduler(null); await repo.removeModelConfig(a.id)
})

it.each(['https://localhost:11434', 'http://example.com', 'http://127.0.0.1@evil.test', 'http://localhost/v1?x=1', 'http://localhost/api'])('rejects non-local or ambiguous endpoint %s', (url) => {
  expect(() => ollamaRoot(url)).toThrow()
})

it('discovers local names and rejects remote aliases, unsupported tools, missing and oversized responses', async () => {
  const signal = new AbortController().signal
  fetchImpl.mockResolvedValueOnce(response({ models: [{ name: 'llama3' }, { name: 'model:cloud' }, { name: 'remote', remote_host: 'https://ollama.com' }] }))
  expect(await discoverOllama(fetchImpl, 'http://localhost:11434/v1', signal)).toEqual(['llama3'])
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] }))
  await expect(verifyOllama(fetchImpl, 'http://localhost:11434', 'llama3', true, signal)).rejects.toThrow('工具')
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion', 'tools'], remote_model: 'cloud' }))
  await expect(verifyOllama(fetchImpl, 'http://localhost:11434', 'llama3', false, signal)).rejects.toThrow('本机')
  fetchImpl.mockResolvedValueOnce(new Response('', { status: 404 }))
  await expect(verifyOllama(fetchImpl, 'http://localhost:11434', 'missing', false, signal)).rejects.toThrow()
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'], padding: 'a'.repeat(262145) }))
  await expect(verifyOllama(fetchImpl, 'http://localhost:11434', 'llama3', false, signal)).rejects.toThrow('过长')
})

it('revalidates local metadata every request, never sends key and fences after async metadata', async () => {
  const local = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'llama3', apiKey: '' })
  expect(local.hasApiKey).toBe(false)
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] })).mockResolvedValueOnce(response({ choices: [{ message: { content: '{}' } }] }))
  expect(await client.selectSpeaker({ projectId: 'local', modelConfigId: local.id, taskRunId: 'r', prompt: 'data' }, async () => true)).toBe('{}')
  expect(fetchImpl.mock.calls[1][1].headers).not.toHaveProperty('Authorization')
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'], remote_host: 'https://ollama.com' }))
  await expect(client.selectSpeaker({ projectId: 'local', modelConfigId: local.id, taskRunId: 'r', prompt: 'private' }, async () => true)).rejects.toThrow('本机')
  expect(fetchImpl).toHaveBeenCalledTimes(3)
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] }))
  await expect(client.selectSpeaker({ projectId: 'local', modelConfigId: local.id, taskRunId: 'r', prompt: 'private' }, async () => false)).rejects.toThrow('失效')
  expect(fetchImpl).toHaveBeenCalledTimes(3)
})

it('sanitizes connection diagnostics without project context or provider secrets', async () => {
  const model = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'test', apiKey: 'SECRET' })
  fetchImpl.mockRejectedValueOnce(new Error('SECRET provider stack'))
  expect(await client.testConnection(model.id)).toEqual({ ok: false, message: '模型连接失败，请检查服务、模型名称和凭证' })
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).messages).toEqual([{ role: 'user', content: 'Hi' }])
})

it.each([
  ['valid', { choices: [{ message: { role: 'assistant', content: 'Hello' } }] }, true],
  ['missing message', { choices: [{}] }, false],
  ['error', { error: { message: 'private stack' } }, false],
  ['error alongside choices', { error: { message: 'private stack' }, choices: [{ message: { role: 'assistant', content: 'Hello' } }] }, false],
  ['invalid role', { choices: [{ message: { role: 'user', content: 'Hi' } }] }, false],
  ['tool call', { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] } }] }, false],
])('tests actual Ollama chat and validates %s response', async (_name, data, ok) => {
  const model = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'llama3', apiKey: '' })
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] })).mockResolvedValueOnce(response(data))
  expect((await client.testConnection(model.id)).ok).toBe(ok)
  expect(fetchImpl.mock.calls[1][0]).toBe('http://127.0.0.1:11434/v1/chat/completions')
  expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ model: 'llama3', stream: false, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
  expect(fetchImpl.mock.calls[1][1].headers).not.toHaveProperty('Authorization')
  expect(fetchImpl.mock.calls[1][1].redirect).toBe('error')
})

it('bounds Ollama connection response size and stops a stalled chat body after ten seconds', async () => {
  const model = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'llama3', apiKey: '' })
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] })).mockResolvedValueOnce(response({ padding: 'x'.repeat(16_385) }))
  expect((await client.testConnection(model.id)).ok).toBe(false)
  vi.useFakeTimers()
  const cancel = vi.fn()
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] })).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } }))
  const pending = client.testConnection(model.id)
  await vi.advanceTimersByTimeAsync(10_000)
  expect((await pending).ok).toBe(false)
  expect(cancel).toHaveBeenCalledOnce()
  expect(fetchImpl.mock.calls.at(-1)![1].signal.aborted).toBe(true)
})

it.each([false, true])('negotiates completion-only Ollama tools; unsolicited call=%s', async (call) => {
  const model = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'llama3', apiKey: '' })
  fetchImpl.mockResolvedValueOnce(response({ capabilities: ['completion'] })).mockResolvedValueOnce(new Response(
    call ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"x","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
      : 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const events: any[] = []
  await client.streamChat({ projectId: 'local', modelConfigId: model.id, taskRunId: 'r', messages: [{ role: 'user', content: 'Hi' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }] }, (event) => { events.push(event) })
  const body = JSON.parse(fetchImpl.mock.calls[1][1].body)
  expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('tool_choice')
  expect(body.messages.at(-1).content).toContain('no tool capability')
  expect(events.map((event) => event.type)).toEqual(call ? ['error'] : ['delta', 'complete'])
})

it('upgrades populated v15 model table without losing references, keys or consents', () => {
  const sqlite = new Database(':memory:')
  try {
    migrate(sqlite)
    sqlite.pragma('foreign_keys = OFF')
    sqlite.exec(`DROP TABLE model_settings;
      ALTER TABLE agents DROP COLUMN source_template_id;
      ALTER TABLE agent_turns DROP COLUMN configured_model_config_id;
      ALTER TABLE agent_turns DROP COLUMN actual_model_config_id;
      ALTER TABLE agent_turns DROP COLUMN configured_model_fingerprint;
      ALTER TABLE agent_turns DROP COLUMN actual_model_fingerprint;
      ALTER TABLE agent_turns DROP COLUMN member_revision;
      ALTER TABLE messages DROP COLUMN actual_model_config_id;
      ALTER TABLE session_summaries DROP COLUMN configured_model_config_id;
      CREATE TABLE model_configs_v15 (id TEXT PRIMARY KEY NOT NULL, provider_preset TEXT NOT NULL CHECK(provider_preset IN ('openai','deepseek')), base_url TEXT NOT NULL, model_name TEXT NOT NULL, encrypted_api_key TEXT NOT NULL, context_window INTEGER, max_output_tokens INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      DROP TABLE model_configs; ALTER TABLE model_configs_v15 RENAME TO model_configs;
      PRAGMA user_version=15;`)
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec(`INSERT INTO projects VALUES ('p','p',NULL,'C:/test','now','now');
      INSERT INTO model_configs VALUES ('m','openai','https://example.test','test','ENCRYPTED',8192,1024,'now','now');
      INSERT INTO channels (id,project_id,name,scheduler_model_config_id,created_at,updated_at) VALUES ('c','p','c','m','now','now');
      INSERT INTO agents VALUES ('a','a',NULL,'title','prompt','m','{}',0,'now','now');
      INSERT INTO channel_agents (channel_id,agent_id,is_enabled,model_config_override_id,created_at,updated_at,revision) VALUES ('c','a',1,'m','now','now','revision');
      INSERT INTO task_runs (id,channel_id,model_config_id,status,created_at) VALUES ('r','c','m','completed','now');
      INSERT INTO session_summaries VALUES ('s','c','r',1,'summary','m','now');
      INSERT INTO cloud_consents VALUES ('p','m','now');
      INSERT INTO tool_result_consents VALUES ('p','m',1,'now');`)
    const tables = ['model_configs','agents','channels','channel_agents','task_runs','session_summaries','cloud_consents','tool_result_consents']
    const before = tables.map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all())
    migrate(sqlite); migrate(sqlite)
    expect(tables.map((table) => (sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[])
      .map(({ fallback_config_id: _fallback, configured_model_config_id: _configured, source_template_id: _template, ...row }) => row))).toEqual(before)
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    sqlite.exec("INSERT INTO model_settings VALUES (1,'m')")
    expect(() => sqlite.exec("DELETE FROM model_configs WHERE id='m'")).toThrow()
    sqlite.exec("INSERT INTO model_configs (id,provider_preset,base_url,model_name,encrypted_api_key,context_window,max_output_tokens,created_at,updated_at) VALUES ('local','ollama','http://localhost:11434/v1','llama','',NULL,NULL,'now','now')")
  } finally { sqlite.close() }
})
