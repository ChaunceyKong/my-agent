import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { createModelClient, type ModelClient } from '../../electron/core/model-client'
import { createTaskRunService } from '../../electron/core/task-run-service'
import type { StreamChatInput, StreamEvent } from '../../shared/types'

let directory: string
let database: DatabaseClient
let repositories: Repositories
let taskRuns: ReturnType<typeof createTaskRunService>
let client: ModelClient
let fetchImpl: ReturnType<typeof vi.fn>
let input: StreamChatInput
let fallback: string
let root: string
let events: StreamEvent[]
const json = (content = '{}') => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } })
const sse = (content = 'answer') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const http = (status: number) => new Response('private Provider error: secret', { status })
const models = () => fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/chat/completions')).map(([, init]) => JSON.parse(init.body).model)
const flush = () => vi.advanceTimersByTimeAsync(0)
const chat = () => client.streamChat(input, (event) => { events.push(event) })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-model-fallback-'))
  database = createDatabase({ filePath: join(directory, 'test.sqlite') })
  repositories = createRepositories(database)
  taskRuns = createTaskRunService(repositories)
  fetchImpl = vi.fn()
  client = createModelClient({ repositories, consent: createCloudConsentService(repositories), taskRuns, fetch: fetchImpl,
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() } })
  const { project, channel } = await repositories.createProjectWithInitialChannel({ name: 'fallback', workspacePath: directory })
  fallback = (await client.saveModelConfig({ providerPreset: 'openai', modelName: 'backup', apiKey: 'secret' })).id
  root = (await client.saveModelConfig({ providerPreset: 'openai', modelName: 'primary', apiKey: 'secret', fallbackConfigId: fallback })).id
  await client.recordCloudConsent(project.id, root)
  await client.recordCloudConsent(project.id, fallback)
  const run = await taskRuns.startTaskRun(channel.id, root, 'goal')
  input = { projectId: project.id, taskRunId: run.id, modelConfigId: root, messages: [{ role: 'user', content: 'goal' }] }
  events = []
  vi.useFakeTimers()
})

afterEach(async () => {
  vi.useRealTimers()
  database.close()
  await rm(directory, { force: true, recursive: true })
})

it('429 waits exactly 2s then 4s before switching and records bounded attempt facts without secrets', async () => {
  fetchImpl.mockImplementation(() => models().length <= 3 ? http(429) : sse())
  const selected: string[] = []
  const pending = client.streamChat(input, (event) => { events.push(event) }, undefined, async (choice) => { selected.push(choice.actualModelConfigId) })
  await flush(); expect(models()).toEqual(['primary'])
  await vi.advanceTimersByTimeAsync(1999); expect(models()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1); expect(models()).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(3999); expect(models()).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1); await pending
  expect(models()).toEqual(['primary', 'primary', 'primary', 'backup'])
  expect(selected).toEqual([root, root, root, fallback])
  expect(events).toEqual([{ taskRunId: input.taskRunId, type: 'delta', content: 'answer' }, { taskRunId: input.taskRunId, type: 'complete' }])
  const facts = (await repositories.listTaskRunEvents(input.taskRunId)).filter((event) => event.eventType.startsWith('model_'))
  expect(facts.map((event) => event.eventType)).toEqual(['model_attempt', 'model_attempt', 'model_attempt', 'model_switched', 'model_attempt'])
  expect(JSON.stringify(facts)).not.toMatch(/secret|encryptedApiKey|modelSnapshot|fingerprint/)
  expect(facts.find((event) => event.eventType === 'model_switched')?.displayReason).toContain('开始尝试')
})

it.each(['5xx', 'transport'])('%s retries once immediately then uses the fallback', async (kind) => {
  fetchImpl.mockImplementation(() => {
    if (models().length > 2) return sse()
    if (kind === 'transport') throw new TypeError('secret connection lost')
    return http(503)
  })
  await chat()
  expect(models()).toEqual(['primary', 'primary', 'backup'])
  expect(events.at(-1)?.type).toBe('complete')
})

it.each([401, 400, 403, 404])('HTTP %s neither retries nor falls back', async (status) => {
  fetchImpl.mockImplementation(() => http(status))
  await chat()
  expect(models()).toEqual(['primary'])
  expect(events).toHaveLength(1)
  expect(events[0].type).toBe('error')
  expect(JSON.stringify(events)).not.toContain('secret')
  if (status === 401) expect(events[0]).toMatchObject({ content: '模型服务拒绝凭证，请检查 API 密钥配置', interventionRequired: true })
})

it('30s network deadline aborts each stalled request, retries once and selects fallback', async () => {
  const signals: AbortSignal[] = []
  fetchImpl.mockImplementation((_url, init) => {
    signals.push(init.signal)
    return models().length > 2 ? Promise.resolve(sse()) : new Promise(() => {})
  })
  const pending = chat()
  await flush(); await vi.advanceTimersByTimeAsync(29999); expect(models()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1); expect(models()).toHaveLength(2); expect(signals[0].aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(30000); await pending
  expect(models()).toEqual(['primary', 'primary', 'backup'])
  expect(signals[1].aborted).toBe(true)
})

it('120s aggregate deadline closes a three-model timeout chain without a late retry', async () => {
  const last = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'last', apiKey: 'secret' })
  await client.saveModelConfig({ id: fallback, providerPreset: 'openai', modelName: 'backup', apiKey: '', fallbackConfigId: last.id })
  await client.recordCloudConsent(input.projectId, fallback); await client.recordCloudConsent(input.projectId, last.id)
  const signals: AbortSignal[] = []
  fetchImpl.mockImplementation((_url, init) => { signals.push(init.signal); return new Promise(() => {}) })
  const pending = chat()
  await flush(); await vi.advanceTimersByTimeAsync(120000); await pending
  expect(models()).toEqual(['primary', 'primary', 'backup', 'backup'])
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(events).toEqual([expect.objectContaining({ type: 'error', content: '模型调用超过 120 秒，请重试', interventionRequired: true })])
  await vi.advanceTimersByTimeAsync(90000); expect(models()).toHaveLength(4)
})

it.each(['delay', 'request'])('real TaskRun cancellation during %s stops all attempts and events', async (phase) => {
  fetchImpl.mockImplementation(() => phase === 'delay' ? http(429) : new Promise(() => {}))
  const pending = chat()
  await flush(); expect(models()).toHaveLength(1)
  await taskRuns.cancelTaskRun(input.taskRunId)
  await flush(); await pending
  await vi.advanceTimersByTimeAsync(120000)
  expect(models()).toHaveLength(1); expect(events).toEqual([])
  const facts = (await repositories.listTaskRunEvents(input.taskRunId)).filter((event) => event.eventType === 'model_attempt')
  expect(facts).toHaveLength(1); expect(facts[0].generation).toBe(0)
})

it('configuration-chain edit during backoff fences the next outward request', async () => {
  fetchImpl.mockImplementation(() => http(429))
  const pending = chat().catch((error) => error)
  await flush()
  await client.saveModelConfig({ id: root, providerPreset: 'openai', modelName: 'primary', apiKey: '', fallbackConfigId: null })
  await client.recordCloudConsent(input.projectId, root)
  await vi.advanceTimersByTimeAsync(2000)
  expect(await pending).toBeInstanceOf(Error)
  expect(models()).toEqual(['primary'])
})

it('fallback requires its own cloud consent even when the primary has consent', async () => {
  await client.saveModelConfig({ id: fallback, providerPreset: 'openai', modelName: 'backup-edited', apiKey: '' })
  fetchImpl.mockImplementation(() => http(503))
  await expect(chat()).rejects.toThrow('实际调用模型授权')
  expect(models()).toEqual(['primary', 'primary'])
})

it('fallback requires separate tool-result consent before sending reconstructed observations', async () => {
  input.hasToolObservations = true
  await repositories.recordToolResultConsent(input.projectId, root, 1)
  fetchImpl.mockImplementation(() => http(503))
  await expect(chat()).rejects.toThrow('实际模型的工具结果上传授权')
  expect(models()).toEqual(['primary', 'primary'])
  await repositories.recordToolResultConsent(input.projectId, fallback, 1)
  fetchImpl.mockImplementation(() => models().at(-1) === 'backup' ? sse() : http(503))
  await chat(); expect(events.at(-1)?.type).toBe('complete')
})

it('fallback rechecks its own budget and does not truncate or transmit the prompt', async () => {
  await client.saveModelConfig({ id: fallback, providerPreset: 'openai', modelName: 'backup', apiKey: '', contextWindow: 2048, maxOutputTokens: 512 })
  await client.recordCloudConsent(input.projectId, fallback)
  input.messages = [{ role: 'user', content: '文'.repeat(700) }]
  fetchImpl.mockImplementation(() => http(503))
  await expect(chat()).rejects.toThrow('预算不足')
  expect(models()).toEqual(['primary', 'primary'])
})

it.each(['visible delta', 'incomplete native tool bytes'])('never retries after %s even when the reader fails', async (kind) => {
  const bytes = kind === 'visible delta' ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' : 'data: {"choices":[{"delta":{"tool_calls":'
  let pulls = 0
  fetchImpl.mockImplementation(() => new Response(new ReadableStream({ pull(controller) {
    if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(bytes))
    else controller.error(new TypeError('secret reader failure'))
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  await chat()
  expect(models()).toEqual(['primary'])
  expect(events.at(-1)).toMatchObject({ type: 'error', content: '模型网络请求失败，请稍后重试' })
  expect(events.some((event) => event.type === 'tool_call' || event.type === 'complete')).toBe(false)
})

it.each(['malformed', 'provider error', 'wrong media type'])('%s is not a retryable transport failure', async (kind) => {
  fetchImpl.mockImplementation(() => kind === 'wrong media type' ? json() : new Response(kind === 'malformed' ? 'data: invalid\n\n' : 'data: {"error":{"message":"secret"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  await chat(); expect(models()).toEqual(['primary']); expect(events.at(-1)?.type).toBe('error')
})

it('pinned post-tool continuation stays on actual fallback without any automatic retry', async () => {
  input.pinnedModelConfigId = fallback; input.disableRetry = true
  fetchImpl.mockImplementation(() => http(503))
  await chat(); expect(models()).toEqual(['backup']); expect(events.at(-1)?.type).toBe('error')
})

it('mixed retryable statuses share a hard attempt limit across at most two fallback transitions', async () => {
  const last = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'last', apiKey: 'secret' })
  await client.saveModelConfig({ id: fallback, providerPreset: 'openai', modelName: 'backup', apiKey: '', fallbackConfigId: last.id })
  await client.recordCloudConsent(input.projectId, fallback); await client.recordCloudConsent(input.projectId, last.id)
  const counts = new Map<string, number>()
  fetchImpl.mockImplementation((_url, init) => {
    const name = JSON.parse(init.body).model
    counts.set(name, (counts.get(name) ?? 0) + 1)
    return http(counts.get(name) === 1 ? 503 : 429)
  })
  const pending = chat(); await flush(); await vi.advanceTimersByTimeAsync(12000); await pending
  expect(models()).toEqual(['primary', 'primary', 'primary', 'backup', 'backup', 'backup', 'last', 'last', 'last'])
  expect(events).toEqual([expect.objectContaining({ type: 'error', interventionRequired: true })])
})

it.each(['speaker', 'summary'])('%s uses the same fallback policy and actual-model selection callback', async (kind) => {
  fetchImpl.mockImplementation(() => models().at(-1) === 'backup' ? json(kind === 'speaker' ? '{"nextSpeaker":null,"reason":"done"}' : 'summary') : http(503))
  const selected: string[] = []
  const call = kind === 'speaker' ? client.selectSpeaker : client.summarizeSession
  const output = await call({ ...input, prompt: 'untrusted context' }, async () => true, async (choice) => { selected.push(choice.actualModelConfigId) })
  expect(output).toContain(kind === 'speaker' ? 'nextSpeaker' : 'summary')
  expect(models()).toEqual(['primary', 'primary', 'backup']); expect(selected.at(-1)).toBe(fallback)
})

it.each(['speaker', 'summary'])('%s malformed JSON response does not retry or fallback', async (kind) => {
  fetchImpl.mockImplementation(() => new Response('{invalid', { headers: { 'content-type': 'application/json' } }))
  const call = kind === 'speaker' ? client.selectSpeaker : client.summarizeSession
  await expect(call({ ...input, prompt: 'context' }, async () => true)).rejects.toThrow('格式异常')
  expect(models()).toEqual(['primary'])
})

it('local Ollama connection refusal is actionable and does not invoke a cloud fallback', async () => {
  const local = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'local', apiKey: '', fallbackConfigId: fallback })
  input.modelConfigId = local.id
  fetchImpl.mockRejectedValue(Object.assign(new TypeError('fetch failed secret'), { cause: { code: 'ECONNREFUSED' } }))
  await chat()
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  expect(events).toEqual([expect.objectContaining({ type: 'error', content: '请先启动 Ollama 服务', interventionRequired: true })])
})

it('fallback Ollama capability refusal does not transmit conversation or fake tools', async () => {
  const local = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'local', apiKey: '' })
  await client.saveModelConfig({ id: root, providerPreset: 'openai', modelName: 'primary', apiKey: '', fallbackConfigId: local.id })
  await client.recordCloudConsent(input.projectId, root)
  fetchImpl.mockImplementation((url) => String(url).endsWith('/api/show') ? new Response(JSON.stringify({ capabilities: [] }), { headers: { 'content-type': 'application/json' } }) : http(503))
  await expect(chat()).rejects.toThrow('不支持对话')
  expect(models()).toEqual(['primary', 'primary'])
})

it('Ollama metadata transport disconnect retries once then falls back without sending local conversation', async () => {
  const local = await client.saveModelConfig({ providerPreset: 'ollama', modelName: 'local', apiKey: '', fallbackConfigId: fallback })
  input.modelConfigId = local.id
  fetchImpl.mockImplementation((url) => String(url).endsWith('/api/show') ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('secret metadata transport')) } }), { headers: { 'content-type': 'application/json' } }) : sse())
  await chat()
  expect(fetchImpl.mock.calls.map(([url]) => String(url).endsWith('/api/show'))).toEqual([true, true, false])
  expect(models()).toEqual(['backup']); expect(events.at(-1)?.type).toBe('complete')
})

it('a delayed stream event cannot emit completion after its 30-second attempt deadline', async () => {
  fetchImpl.mockImplementation(() => sse())
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const pending = client.streamChat(input, async (event) => {
    events.push(event)
    if (event.type === 'delta') await held
  })
  await flush(); expect(events.map((event) => event.type)).toEqual(['delta'])
  await vi.advanceTimersByTimeAsync(30000); await pending
  release(); await flush()
  expect(events.map((event) => event.type)).toEqual(['delta', 'error'])
  expect(models()).toEqual(['primary'])
})
