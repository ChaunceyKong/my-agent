import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { createModelClient, type CryptoAdapter, type ModelClient } from '../../electron/core/model-client'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { StreamEvent } from '../../shared/types'

const cryptoAdapter: CryptoAdapter = {
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
  isEncryptionAvailable: () => true,
}

let database: DatabaseClient
let repositories: Repositories
let testDirectory: string
let canAcceptChunk: ReturnType<typeof vi.fn>
let fetchImpl: ReturnType<typeof vi.fn>
let client: ModelClient

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'agent-team-model-'))
  database = createDatabase({ filePath: join(testDirectory, 'agent-team.sqlite') })
  repositories = createRepositories(database)
  canAcceptChunk = vi.fn().mockResolvedValue(true)
  fetchImpl = vi.fn()
  client = createModelClient({
    repositories,
    consent: createCloudConsentService(repositories),
    taskRuns: { canAcceptChunk, onCancelled: () => () => {} },
    crypto: cryptoAdapter,
    fetch: fetchImpl,
  })
})

afterEach(async () => {
  database.close()
  await rm(testDirectory, { force: true, recursive: true })
})

async function createProjectAndModel(): Promise<{ projectId: string; modelConfigId: string }> {
  const { project } = await repositories.createProjectWithInitialChannel({
    name: '模型测试',
    workspacePath: testDirectory,
  })
  const model = await client.saveModelConfig({
    providerPreset: 'deepseek',
    modelName: 'deepseek-chat',
    apiKey: 'secret',
  })
  await client.recordCloudConsent(project.id, model.id)
  return { projectId: project.id, modelConfigId: model.id }
}

describe('scheduler request', () => {
  it('reserves scheduler output tokens and rejects overflow before dispatch', async () => {
    const { projectId } = await createProjectAndModel()
    const model = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'small', apiKey: 'secret', contextWindow: 2048, maxOutputTokens: 512 })
    await client.recordCloudConsent(projectId, model.id)
    await expect(client.selectSpeaker({ projectId, modelConfigId: model.id, taskRunId: 'run', prompt: '文'.repeat(500) }, async () => true)).rejects.toThrow('预算不足')
    expect(fetchImpl).not.toHaveBeenCalled()
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { headers: { 'content-type': 'application/json' } }))
    await client.selectSpeaker({ projectId, modelConfigId: model.id, taskRunId: 'run', prompt: '{}' }, async () => true)
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_tokens).toBe(512)
  })
  it('requires exact summary consent and bounds multilingual prompt and Provider response', async () => {
    const { projectId, modelConfigId } = await createProjectAndModel()
    const other = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'other', apiKey: 'secret' })
    await expect(client.summarizeSession({ projectId, modelConfigId: other.id, taskRunId: 'run', prompt: 'private' }, async () => true)).rejects.toThrow('consent')
    await expect(client.summarizeSession({ projectId, modelConfigId, taskRunId: 'run', prompt: '文'.repeat(3000) }, async () => true)).rejects.toThrow('预算不足')
    await expect(client.summarizeSession({ projectId, modelConfigId, taskRunId: 'run', prompt: 'private' }, async () => false)).rejects.toThrow('失效')
    expect(fetchImpl).not.toHaveBeenCalled()
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'summary' } }] }), { headers: { 'content-type': 'application/json' } }))
    expect(await client.summarizeSession({ projectId, modelConfigId, taskRunId: 'run', prompt: 'private' }, async () => true)).toBe('summary')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ stream: false, max_tokens: 1024 })
    fetchImpl.mockResolvedValueOnce(new Response('x'.repeat(17000), { headers: { 'content-type': 'application/json' } }))
    await expect(client.summarizeSession({ projectId, modelConfigId, taskRunId: 'run', prompt: 'private' }, async () => true)).rejects.toThrow('过长')
  })
  it('does not send any scheduling context without exact Project/ModelConfig consent', async () => {
    const { projectId, modelConfigId } = await createProjectAndModel()
    const other = (await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'other', encryptedApiKey: 'secret' })).id
    await expect(client.selectSpeaker({ projectId, modelConfigId: other, taskRunId: 'run', prompt: 'private context' }, async () => true)).rejects.toThrow('consent')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rechecks the decision fence before sending and bounds Provider output', async () => {
    const { projectId, modelConfigId } = await createProjectAndModel()
    await expect(client.selectSpeaker({ projectId, modelConfigId, taskRunId: 'run', prompt: 'private context' }, async () => false)).rejects.toThrow('失效')
    expect(fetchImpl).not.toHaveBeenCalled()
    fetchImpl.mockResolvedValue(new Response('x'.repeat(17_000), { headers: { 'content-type': 'application/json' } }))
    await expect(client.selectSpeaker({ projectId, modelConfigId, taskRunId: 'run', prompt: 'private context' }, async () => true)).rejects.toThrow('过长')
  })
})

it.each(['turn', 'model'])('rechecks %s after a delayed final cloud-consent check', async (changed) => {
  const { projectId, modelConfigId } = await createProjectAndModel()
  let release!: () => void
  let entered!: () => void
  const enteredGate = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const consent = createCloudConsentService(repositories)
  const original = consent.requireCloudConsent
  let checks = 0
  consent.requireCloudConsent = async (...args) => {
    await original(...args)
    if (++checks === 2) { entered(); await gate }
  }
  const delayed = createModelClient({ repositories, consent, taskRuns: { canAcceptChunk, onCancelled: () => () => {} }, crypto: cryptoAdapter, fetch: fetchImpl })
  let valid = true
  const request = delayed.streamChat({ projectId, modelConfigId, taskRunId: 'run', messages: [{ role: 'user', content: 'private' }] }, vi.fn(), async () => valid)
  const observed = request.catch((error) => error)
  await enteredGate
  if (changed === 'turn') valid = false
  else database.db.run(sql`UPDATE model_configs SET model_name = 'changed' WHERE id = ${modelConfigId}`)
  release()
  await observed
  expect(fetchImpl).not.toHaveBeenCalled()
})

function streamResponse(parts: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('model configuration', () => {
  it.each(['\r', '\n', '\r\n'])('rejects API keys containing %j before encryption or persistence', async (newline) => {
    const encrypt = vi.spyOn(cryptoAdapter, 'encryptString')
    try {
      await expect(client.saveModelConfig({
        providerPreset: 'openai', modelName: 'gpt-test', apiKey: `FAKE_SECRET_123${newline}x`,
      })).rejects.toThrow('API 密钥不能包含换行符')
      expect(encrypt).not.toHaveBeenCalled()
      expect(await repositories.listModelConfigs()).toEqual([])
    } finally {
      encrypt.mockRestore()
    }
  })

  it('never returns the api key when saving a model config', async () => {
    const saved = await client.saveModelConfig({
      providerPreset: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-chat',
      apiKey: 'secret',
    })

    expect(saved).not.toHaveProperty('apiKey')
    expect(saved).not.toHaveProperty('encryptedApiKey')
    expect(saved).toMatchObject({
      providerPreset: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      modelName: 'deepseek-chat',
      hasApiKey: true,
    })
    expect((await repositories.getModelConfig(saved.id))?.encryptedApiKey).toBe(
      Buffer.from('encrypted:secret').toString('base64'),
    )
  })

  it('uses provider base URL defaults and lists only safe summaries', async () => {
    const openai = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'gpt-test', apiKey: 'openai-key' })
    const deepseek = await client.saveModelConfig({ providerPreset: 'deepseek', modelName: 'deepseek-chat', apiKey: 'deepseek-key' })

    expect(openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com')
    expect(await client.listModelConfigs()).toEqual([openai, deepseek])
    expect(JSON.stringify(await client.listModelConfigs())).not.toContain('key')
  })

  it('accepts the api key only through model:save and returns safe IPC values', async () => {
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
    registerHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: vi.fn() },
      repositories,
      modelClient: client,
    })

    const saved = await handlers.get(IpcChannel.ModelSave)?.(undefined, {
      providerPreset: 'openai',
      modelName: 'gpt-test',
      apiKey: 'ipc-secret',
    })
    const listed = await handlers.get(IpcChannel.ModelList)?.(undefined)

    expect(saved).toMatchObject({ hasApiKey: true })
    expect(JSON.stringify(saved)).not.toContain('ipc-secret')
    expect(listed).toEqual([saved])
    expect(JSON.stringify(listed)).not.toContain('ipc-secret')
  })
})

describe('OpenAI-compatible streaming', () => {
  it('accepts role, content, finish and usage chunks before a framed terminal marker', async () => {
    const ids = await createProjectAndModel()
    fetchImpl.mockResolvedValue(streamResponse([
      ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant","content":""}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"total_tokens":2}}\r\n\r\ndata: [DONE]\r\n\r\n',
    ]))
    const events: StreamEvent[] = []
    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, (event) => { events.push(event) })
    expect(events).toEqual([
      { taskRunId: 'run-1', type: 'delta', content: '你好' },
      { taskRunId: 'run-1', type: 'complete' },
    ])
  })

  it('waits for async event persistence before delivering the next event', async () => {
    const ids = await createProjectAndModel()
    fetchImpl.mockResolvedValue(streamResponse(['data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n']))
    const delivered: string[] = []
    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, async (event) => {
      if (event.type === 'delta') await new Promise((resolve) => setTimeout(resolve, 15))
      delivered.push(event.type)
    })
    expect(delivered).toEqual(['delta', 'complete'])
  })

  it('requires persisted consent before making a cloud request', async () => {
    const { project } = await repositories.createProjectWithInitialChannel({ name: '未同意', workspacePath: testDirectory })
    const model = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'gpt-test', apiKey: 'secret' })

    await expect(client.streamChat({
      projectId: project.id,
      modelConfigId: model.id,
      taskRunId: 'run-1',
      messages: [],
    }, vi.fn())).rejects.toThrow('Cloud consent is required')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('parses split SSE data and emits deltas followed by completion', async () => {
    const ids = await createProjectAndModel()
    fetchImpl.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      '\ndata: [DONE]\n\n',
    ]))
    const events: StreamEvent[] = []

    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [{ role: 'user', content: '你好' }] }, (event) => {
      events.push(event)
    })

    expect(events).toEqual([
      { taskRunId: 'run-1', type: 'delta', content: '你' },
      { taskRunId: 'run-1', type: 'delta', content: '好' },
      { taskRunId: 'run-1', type: 'complete' },
    ])
    expect(canAcceptChunk).toHaveBeenCalledTimes(5)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }], stream: true, max_tokens: 1024 }),
    }))
  })

  it('does not make a request or emit an event once its run is cancelled', async () => {
    const ids = await createProjectAndModel()
    canAcceptChunk.mockResolvedValue(false)
    const emit = vi.fn()

    await client.streamChat({ ...ids, taskRunId: 'cancelled-run', messages: [] }, emit)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('checks run state before every stream event and stops after cancellation', async () => {
    const ids = await createProjectAndModel()
    fetchImpl.mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    canAcceptChunk
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const emit = vi.fn()

    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, emit)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ taskRunId: 'run-1', type: 'delta', content: 'first' })
  })

  it('emits a guarded error event when the network request fails', async () => {
    const ids = await createProjectAndModel()
    fetchImpl.mockRejectedValue(new Error('connection lost'))
    const emit = vi.fn()

    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, emit)

    expect(emit).toHaveBeenCalledWith({ taskRunId: 'run-1', type: 'error', content: '模型网络请求失败，请稍后重试' })
    expect(canAcceptChunk).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['transport error', () => Promise.reject(new Error('Authorization: Bearer secret')), '模型网络请求失败，请稍后重试'],
    ['non-Error rejection', () => Promise.reject('Authorization: Bearer secret'), '模型网络请求失败，请稍后重试'],
    ['abort', () => Promise.reject(new DOMException('Authorization: Bearer secret', 'AbortError')), '模型请求已取消'],
    ['HTTP failure', () => new Response('Authorization: Bearer secret', { status: 401 }), '模型服务请求失败，请检查配置后重试'],
    ['missing stream', () => new Response(null), '模型响应格式异常，请稍后重试'],
    ['malformed SSE', () => streamResponse(['data: {Authorization: Bearer secret}\n\n']), '模型响应格式异常，请稍后重试'],
    ['provider error', () => streamResponse(['data: {"error":{"message":"Authorization: Bearer secret"}}\n\n']), '模型服务返回错误，请稍后重试'],
    ['reader failure', () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('Authorization: Bearer secret')) },
    }), { headers: { 'content-type': 'text/event-stream' } }), '模型网络请求失败，请稍后重试'],
  ])('never exposes credentials from %s', async (_name, response, message) => {
    const ids = await createProjectAndModel()
    fetchImpl.mockImplementation(response)
    const events: StreamEvent[] = []

    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, (event) => { events.push(event) })

    expect(JSON.stringify(events)).not.toContain('secret')
    expect(events).toEqual([{ taskRunId: 'run-1', type: 'error', content: message }])
    expect(canAcceptChunk).toHaveBeenCalledTimes(3)
  })

  it.each(['\r', '\n', '\r\n'])('rejects a legacy stored API key containing %j before requesting', async (newline) => {
    const { project } = await repositories.createProjectWithInitialChannel({ name: '旧配置', workspacePath: testDirectory })
    const model = await repositories.saveModelConfig({
      providerPreset: 'openai', baseUrl: 'https://api.openai.com/v1', modelName: 'gpt-test',
      encryptedApiKey: cryptoAdapter.encryptString(`FAKE_SECRET_123${newline}x`).toString('base64'),
    })
    await client.recordCloudConsent(project.id, model.id)
    const events: StreamEvent[] = []

    await client.streamChat({ projectId: project.id, modelConfigId: model.id, taskRunId: 'run-1', messages: [] }, (event) => { events.push(event) })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(events).toEqual([{ taskRunId: 'run-1', type: 'error', content: 'API 密钥不能包含换行符' }])
    expect(JSON.stringify(events)).not.toContain('FAKE_SECRET_123')
  })

  it('suppresses errors after run cancellation', async () => {
    const ids = await createProjectAndModel()
    fetchImpl.mockRejectedValue(new Error('Authorization: Bearer secret'))
    canAcceptChunk.mockResolvedValueOnce(true).mockResolvedValue(false)
    const emit = vi.fn()

    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, emit)

    expect(emit).not.toHaveBeenCalled()
  })

  it('emits native tool calls only after a tool_calls terminal frame', async () => {
    const ids = await createProjectAndModel(); const events: StreamEvent[] = []
    fetchImpl.mockResolvedValue(streamResponse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n']))
    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }] }, (event) => { events.push(event) })
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', toolCall: expect.objectContaining({ id: 'call_1' }) }))
  })

  it.each([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":-1,"id":"a","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
  ])('fails closed for incomplete or invalid tool-call streams', async (body) => {
    const ids = await createProjectAndModel(); const events: StreamEvent[] = []; fetchImpl.mockResolvedValue(streamResponse([body]))
    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }] }, (event) => { events.push(event) })
    expect(events).toEqual([expect.objectContaining({ type: 'error', content: '模型响应格式异常，请稍后重试' })])
  })

  it('rejects any fragment appended after the tool_calls terminal frame', async () => {
    const ids = await createProjectAndModel(); const events: StreamEvent[] = []
    fetchImpl.mockResolvedValue(streamResponse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"evil"}}]}}]}\n\n', 'data: [DONE]\n\n']))
    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [], tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }] }, (event) => { events.push(event) })
    expect(events).toEqual([expect.objectContaining({ type: 'error', content: '模型响应格式异常，请稍后重试' })])
  })

  it('rejects an empty tool_calls terminal response', async () => {
    const ids = await createProjectAndModel(); const events: StreamEvent[] = []
    fetchImpl.mockResolvedValue(streamResponse(['data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n']))
    await client.streamChat({ ...ids, taskRunId: 'run-1', messages: [] }, (event) => { events.push(event) })
    expect(events).toEqual([expect.objectContaining({ type: 'error', content: '模型响应格式异常，请稍后重试' })])
  })
})
