import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    taskRuns: { canAcceptChunk },
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
    expect(canAcceptChunk).toHaveBeenCalledTimes(4)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }], stream: true }),
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

    expect(emit).toHaveBeenCalledWith({ taskRunId: 'run-1', type: 'error', content: 'connection lost' })
    expect(canAcceptChunk).toHaveBeenCalledTimes(2)
  })
})
