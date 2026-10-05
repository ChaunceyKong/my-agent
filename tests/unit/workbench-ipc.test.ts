import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { createModelClient } from '../../electron/core/model-client'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'

let directory: string
let database: DatabaseClient
let repositories: Repositories
let handlers: Map<string, (event: unknown, ...args: any[]) => any>
let fetchImpl: ReturnType<typeof vi.fn>
let sender: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }
let channelId: string
let projectId: string
let modelConfigId: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workbench-ipc-'))
  database = createDatabase({ filePath: join(directory, 'test.sqlite') })
  repositories = createRepositories(database)
  const taskRuns = createTaskRunService(repositories)
  fetchImpl = vi.fn()
  const modelClient = createModelClient({ repositories, taskRuns, consent: createCloudConsentService(repositories), fetch: fetchImpl,
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() } })
  const created = await repositories.createProjectWithInitialChannel({ name: '测试', workspacePath: directory })
  channelId = created.channel.id
  projectId = created.project.id
  modelConfigId = (await modelClient.saveModelConfig({ providerPreset: 'deepseek', modelName: 'test-model', apiKey: 'PRIVATE_KEY' })).id
  handlers = new Map()
  sender = { send: vi.fn(), isDestroyed: () => false }
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) }, repositories, taskRuns, modelClient })
})
afterEach(async () => { database.close(); await rm(directory, { recursive: true, force: true }) })

const invoke = (name: IpcChannel, ...args: any[]) => handlers.get(name)!({ sender }, ...args)
it('answers five current group members from real records without a model or cloud consent, and refreshes the next query', async () => {
  const agents = []
  for (let index = 0; index < 5; index++) {
    const agent = await repositories.createAgent({ name: `成员${index + 1}`, title: `角色${index + 1}`, avatar: null, systemPrompt: 'PRIVATE_PROMPT', modelConfigId, defaultToolPermissions: {} })
    agents.push(agent)
    await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  }
  const outside = await repositories.createAgent({ name: '其他群聊独有成员', title: '', avatar: null, systemPrompt: '', modelConfigId, defaultToolPermissions: {} })
  const other = await repositories.createChannel({ projectId, name: '其他群聊' })
  await repositories.saveChannelAgent({ channelId: other.id, agentId: outside.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const ask = () => invoke(IpcChannel.MessageSend, { channelId, modelConfigId, content: '当前群聊有多少位 Agent？请列出名单和启用状态。' })
  const first = await ask()
  expect(await repositories.getTaskRun(first.taskRunId)).toMatchObject({ status: 'completed', turnCount: 0 })
  const reply = (await repositories.listMessages(channelId)).at(-1)!
  expect(reply.content).toContain('**5 位 Agent**')
  for (const agent of agents) expect(reply.content).toContain(agent.name)
  expect(reply.content).not.toMatch(/其他群聊独有成员|PRIVATE_PROMPT/)
  expect(reply.actualModelConfigId).toBeNull()
  await repositories.saveChannelAgent({ channelId, agentId: agents[0].id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await ask()
  expect((await repositories.listMessages(channelId)).at(-1)!.content).toContain('**4 位已启用**')
  expect(fetchImpl).not.toHaveBeenCalled()
})
const send = () => invoke(IpcChannel.MessageSend, { channelId, modelConfigId, content: '你好' })

it('ordinary chat includes disabled current group members but excludes Agents from other groups', async () => {
  const agent = await repositories.createAgent({ name: '已停用作者', title: '写作', avatar: null, systemPrompt: 'PRIVATE_DISABLED_PROMPT', modelConfigId, defaultToolPermissions: {} })
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const other = await repositories.createChannel({ projectId, name: '其他群聊' })
  const outsider = await repositories.createAgent({ name: '不应外发的其他成员', title: 'PRIVATE_OTHER_ROLE', avatar: null, systemPrompt: 'PRIVATE_OTHER_PROMPT', modelConfigId, defaultToolPermissions: {} })
  await repositories.saveChannelAgent({ channelId: other.id, agentId: outsider.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  fetchImpl.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"有一位已停用 Agent"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, { taskRunId, generation: 0, type: 'complete' }))
  const system = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content
  expect(system).toContain('"total":1,"enabledCount":0')
  expect(system).toContain('"name":"已停用作者","title":"写作","isEnabled":false')
  expect(system).not.toMatch(/不应外发|PRIVATE_DISABLED_PROMPT|PRIVATE_OTHER/)
})

it('returns one ordered durable snapshot without prompts, roots, keys or event metadata', async () => {
  const agent = await repositories.createAgent({ name: 'snapshot-agent', title: 'test', avatar: '🧭', systemPrompt: 'PRIVATE_SYSTEM_PROMPT', modelConfigId, defaultToolPermissions: {} })
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const run = await repositories.createStartedTaskRun({ channelId, modelConfigId, content: 'CEO input', mentions: [{ agentId: agent.id, start: 0, end: 15, text: '@snapshot-agent' }] }).catch(() => undefined)
  // A malformed mention must not leave a half-created snapshot.
  expect(run).toBeUndefined()
  const created = await repositories.createStartedTaskRun({ channelId, modelConfigId, content: '@snapshot-agent input', mentions: [{ agentId: agent.id, start: 0, end: 15, text: '@snapshot-agent' }] })
  const snapshot = await invoke(IpcChannel.TaskRunSnapshot, channelId)
  expect(snapshot.runs).toEqual([created]); expect(snapshot.messages.map((item: any) => item.content)).toEqual(['@snapshot-agent input'])
  expect(snapshot.events.map((item: any) => item.seq)).toEqual([1, 2]); expect(snapshot.events.every((item: any) => !Object.hasOwn(item, 'metadataJson'))).toBe(true)
  expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_KEY|PRIVATE_SYSTEM_PROMPT|workspacePath|encryptedApiKey|policySnapshotJson|inputJson/)
  await expect(Promise.resolve().then(() => invoke(IpcChannel.TaskRunSnapshot, '../invalid'))).rejects.toThrow('请求无效')
})

it.each(['fetch', 'stream'])('rejects zero-Agent old model response after edit during %s', async (phase) => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  let release!: (response?: Response) => void
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  if (phase === 'fetch') fetchImpl.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve as typeof release }))
  else fetchImpl.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value } }), { headers: { 'Content-Type': 'text/event-stream' } }))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
  if (phase === 'stream') {
    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"before"}}]}\n\n'))
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, expect.objectContaining({ type: 'delta' })))
  }
  await invoke(IpcChannel.ModelSave, { id: modelConfigId, providerPreset: 'deepseek', modelName: 'edited', apiKey: '' })
  const late = 'data: {"choices":[{"delta":{"content":"old reply"}}]}\n\ndata: [DONE]\n\n'
  if (phase === 'fetch') release(new Response(late, { headers: { 'Content-Type': 'text/event-stream' } }))
  else { controller.enqueue(encoder.encode(late)); controller.close() }
  await vi.waitFor(async () => expect((await repositories.getTaskRun(taskRunId))?.status).toBe('failed'))
  expect((await repositories.listMessages(channelId)).filter((message) => message.role === 'agent')).toEqual([])
  expect(sender.send.mock.calls.some(([, event]) => event.type === 'complete' || event.content === 'old reply')).toBe(false)
})

it.each(['model', 'member'])('rejects zero-Agent completion if %s changes at commit', async (change) => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  const transition = repositories.transitionTaskRun.bind(repositories)
  vi.spyOn(repositories, 'transitionTaskRun').mockImplementation(async (id, from, to, metadata, guard) => {
    if (to === 'completed') {
      if (change === 'model') await invoke(IpcChannel.ModelSave, { id: modelConfigId, providerPreset: 'deepseek', modelName: 'edited', apiKey: '' })
      else {
        const agent = await repositories.createAgent({ name: 'Alpha', avatar: null, title: '', systemPrompt: 'Prompt', modelConfigId, defaultToolPermissions: {} })
        await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
      }
    }
    return transition(id, from, to, metadata, guard)
  })
  fetchImpl.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"old reply"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const { taskRunId } = await send()
  await vi.waitFor(async () => expect((await repositories.getTaskRun(taskRunId))?.status).toBe('failed'))
  expect((await repositories.listMessages(channelId)).filter((message) => message.role === 'agent')).toEqual([])
  expect(sender.send.mock.calls.some(([, event]) => event.type === 'complete')).toBe(false)
})

it('does not commit or fail a newer generation from an old zero-Agent completion', async () => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  const transition = repositories.transitionTaskRun.bind(repositories)
  let committed = false
  vi.spyOn(repositories, 'transitionTaskRun').mockImplementation(async (id, from, to, metadata, guard) => {
    if (to === 'completed') await repositories.advanceTaskRunGeneration(id)
    const result = await transition(id, from, to, metadata, guard)
    if (to === 'completed') committed = true
    return result
  })
  fetchImpl.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"old reply"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(committed).toBe(true))
  expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'running', generation: 1 })
  expect((await repositories.listMessages(channelId)).filter((message) => message.role === 'agent')).toEqual([])
  expect(sender.send.mock.calls.some(([, event]) => event.type === 'complete' || event.type === 'error')).toBe(false)
})

it('requires pair-specific Main consent before creating a run or requesting the model', async () => {
  expect(await invoke(IpcChannel.CloudConsentHas, projectId, modelConfigId)).toBe(false)
  await expect(send()).rejects.toThrow()
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await repositories.listMessages(channelId)).toEqual([])
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  expect(await invoke(IpcChannel.CloudConsentHas, projectId, modelConfigId)).toBe(true)
})

it('rejects forged or missing tool-result upload consent at the Main IPC boundary', async () => {
  await expect(invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId)).rejects.toThrow('明确授权')
  await expect(invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: false })).rejects.toThrow('明确授权')
  expect(await repositories.hasCloudConsent(projectId, modelConfigId)).toBe(false)
})

it('never returns an absolute workspace root to renderer project or picker IPC', async () => {
  const projects = await invoke(IpcChannel.ProjectList)
  expect(projects[0]).not.toHaveProperty('workspacePath')
  const picked = await invoke(IpcChannel.ProjectPickWorkspace)
  expect(picked).toBeUndefined()
})

it('rejects dangerous executable registrations before persisting them', async () => {
  for (const input of [
    { id: 'node', absolutePath: 'C:\\node.exe', isEnabled: true, allowedArgs: ['--eval', 'process.exit(0)'] },
    { id: 'python', absolutePath: 'C:\\python.exe', isEnabled: true, allowedArgs: ['-c', 'print(1)'] },
    { id: 'git', absolutePath: 'C:\\git.exe', isEnabled: true, allowedArgs: ['reset', '--hard'] },
    { id: 'star', absolutePath: 'C:\\tool.exe', isEnabled: true, allowedArgs: ['*'] },
    { id: 'node-dot', absolutePath: 'C:\\node.exe.', isEnabled: true, allowedArgs: ['--eval', 'process.exit(0)'] },
    { id: 'node-space', absolutePath: 'C:\\node.exe ', isEnabled: true, allowedArgs: ['--eval', 'process.exit(0)'] },
    { id: 'git-dot', absolutePath: 'C:\\git.exe.', isEnabled: true, allowedArgs: ['reset', '--hard'] },
  ]) await expect(invoke(IpcChannel.ExecutableSave, input)).rejects.toThrow('登记程序无效')
  expect(await repositories.listRegisteredExecutables()).toEqual([])
})

it('allows only Main-validated replacement of a Windows executable registration with the same id', async () => {
  await invoke(IpcChannel.ExecutableSave, { id: 'safe-tool', absolutePath: 'C:\\safe\\tool.exe', isEnabled: true, allowedArgs: ['status'] })
  await invoke(IpcChannel.ExecutableSave, { id: 'safe-tool', absolutePath: 'C:\\safe\\tool-v2.exe', isEnabled: true, allowedArgs: ['version'] })
  expect(await repositories.getRegisteredExecutable('safe-tool')).toMatchObject({
    id: 'safe-tool', absolutePath: 'C:\\safe\\tool-v2.exe', isEnabled: true, argumentPolicyJson: '["version"]',
  })
})

it('streams from Main, persists reply and terminal state, and returns only safe channel data', async () => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  fetchImpl.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"你好，主理人"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, { taskRunId, generation: 0, type: 'complete' }))
  const messages = await invoke(IpcChannel.MessageList, channelId)
  expect(messages.map((message: any) => message.content)).toEqual(['你好', '你好，主理人'])
  expect(await invoke(IpcChannel.TaskRunList, channelId)).toEqual([expect.objectContaining({ id: taskRunId, status: 'completed' })])
  const summaries = await invoke(IpcChannel.ModelList)
  expect(JSON.stringify({ messages, summaries, events: sender.send.mock.calls })).not.toContain('PRIVATE_KEY')
  expect(summaries[0]).not.toHaveProperty('encryptedApiKey')
  const other = await repositories.createChannel({ projectId, name: '第二群' })
  expect(await invoke(IpcChannel.MessageList, other.id)).toEqual([])
})

it('blocks the no-Agent request when a member is enabled during delayed model consent', async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let checks = 0
  const modelClient = createModelClient({ repositories, taskRuns: createTaskRunService(repositories), fetch: fetchImpl,
    consent: { recordCloudConsent: vi.fn(), requireCloudConsent: async () => { if (++checks === 2) { entered(); await gate } } },
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() },
  })
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: vi.fn() }, repositories, taskRuns: createTaskRunService(repositories), modelClient })
  const { taskRunId } = await send()
  await waiting
  const agent = await repositories.createAgent({ name: 'Alpha', avatar: null, title: '', systemPrompt: 'Prompt', modelConfigId, defaultToolPermissions: {} })
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  release()
  await vi.waitFor(async () => expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'failed' }))
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, expect.objectContaining({ taskRunId, type: 'error' }))
})

it('rejects duplicate channel sends and suppresses stream events after cancellation', async () => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  let resolveFetch!: (response: Response) => void
  fetchImpl.mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled())
  await expect(send()).rejects.toThrow()
  await invoke(IpcChannel.TaskRunCancel, taskRunId)
  resolveFetch(new Response('data: {"choices":[{"delta":{"content":"late"}}]}\n\ndata: [DONE]\n\n'))
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(sender.send).not.toHaveBeenCalled()
  expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'cancelled' })
  expect(await repositories.listMessages(channelId)).toHaveLength(1)
})

it('pauses after exhausted network retries with sanitized errors', async () => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  fetchImpl.mockRejectedValue(new Error('PRIVATE_KEY'))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, expect.objectContaining({ taskRunId, type: 'error' })))
  expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'paused' })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(sender.send.mock.calls)).not.toContain('PRIVATE_KEY')
})

it.each([
  ['empty body', '', 'text/event-stream'],
  ['HTML', '<html>PRIVATE_KEY</html>', 'text/html'],
  ['non-SSE', 'PRIVATE_KEY', 'text/event-stream'],
  ['malformed JSON', 'data: {PRIVATE_KEY}\n\ndata: [DONE]\n\n', 'text/event-stream'],
  ['invalid shape', 'data: {"choices":"PRIVATE_KEY"}\n\ndata: [DONE]\n\n', 'text/event-stream'],
  ['invalid content', 'data: {"choices":[{"delta":{"content":42}}]}\n\ndata: [DONE]\n\n', 'text/event-stream'],
  ['bare terminal', 'data: [DONE]\n\n', 'text/event-stream'],
  ['partial delta EOF', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'text/event-stream'],
  ['unterminated terminal', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]', 'text/event-stream'],
])('fails %s without persisting a completed assistant reply', async (_name, body, contentType) => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  fetchImpl.mockResolvedValue(new Response(body, { headers: { 'content-type': contentType } }))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, {
    taskRunId, generation: 0, type: 'error', content: '模型响应格式异常，请稍后重试',
  }))
  expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'failed', errorMessage: '模型响应格式异常，请稍后重试' })
  expect(await repositories.listMessages(channelId)).toEqual([expect.objectContaining({ role: 'ceo', content: '你好' })])
  expect(sender.send.mock.calls.some(([, event]) => event.type === 'complete')).toBe(false)
  expect(JSON.stringify(sender.send.mock.calls)).not.toContain('PRIVATE_KEY')
})
