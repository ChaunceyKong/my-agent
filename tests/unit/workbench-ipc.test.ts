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
const send = () => invoke(IpcChannel.MessageSend, { channelId, modelConfigId, content: '你好' })

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
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, { taskRunId, type: 'complete' }))
  const messages = await invoke(IpcChannel.MessageList, channelId)
  expect(messages.map((message: any) => message.content)).toEqual(['你好', '你好，主理人'])
  expect(await invoke(IpcChannel.TaskRunList, channelId)).toEqual([expect.objectContaining({ id: taskRunId, status: 'completed' })])
  const summaries = await invoke(IpcChannel.ModelList)
  expect(JSON.stringify({ messages, summaries, events: sender.send.mock.calls })).not.toContain('PRIVATE_KEY')
  expect(summaries[0]).not.toHaveProperty('encryptedApiKey')
  const other = await repositories.createChannel({ projectId, name: '第二群' })
  expect(await invoke(IpcChannel.MessageList, other.id)).toEqual([])
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

it('persists model failure with sanitized errors', async () => {
  await invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, { allowToolResultUpload: true })
  fetchImpl.mockRejectedValue(new Error('PRIVATE_KEY'))
  const { taskRunId } = await send()
  await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(IpcChannel.MessageStream, expect.objectContaining({ taskRunId, type: 'error' })))
  expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'failed' })
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
    taskRunId, type: 'error', content: '模型响应格式异常，请稍后重试',
  }))
  expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'failed', errorMessage: '模型响应格式异常，请稍后重试' })
  expect(await repositories.listMessages(channelId)).toEqual([expect.objectContaining({ role: 'ceo', content: '你好' })])
  expect(sender.send.mock.calls.some(([, event]) => event.type === 'complete')).toBe(false)
  expect(JSON.stringify(sender.send.mock.calls)).not.toContain('PRIVATE_KEY')
})
