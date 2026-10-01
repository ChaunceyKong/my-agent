import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { approvalRequests, overwritePublications, taskRuns, toolExecutions } from '../../electron/database/schema'
import { createAgentService } from '../../electron/core/agent-service'
import { createTaskRunService, type TaskRunService } from '../../electron/core/task-run-service'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { Agent, TaskRun } from '../../shared/types'

let db: DatabaseClient
let repo: Repositories
let tasks: TaskRunService
let channelId: string
let projectId: string
let modelId: string
let agent: Agent
beforeEach(async () => {
  db = createDatabase({ filePath: ':memory:' }); repo = createRepositories(db); tasks = createTaskRunService(repo)
  const created = await repo.createProjectWithInitialChannel({ name: 'project', workspacePath: 'C:/keep-workspace' })
  channelId = created.channel.id; projectId = created.project.id
  modelId = (await repo.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'PRIVATE_KEY' })).id
  agent = await repo.createAgent({ name: 'Writer', avatar: '✍️', title: 'writer', systemPrompt: 'prompt', modelConfigId: modelId, defaultToolPermissions: { read_file: true, write_file: true, run_process: true } })
  await repo.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
})
afterEach(() => db.close())
const start = () => repo.createStartedTaskRun({ channelId, modelConfigId: modelId, content: 'goal' })
const terminal = (run: TaskRun) => db.db.update(taskRuns).set({ status: 'completed', currentTurnId: null }).where(eq(taskRuns.id, run.id)).run()
function ipc() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showOpenDialog: vi.fn() }, repositories: repo, taskRuns: tasks })
  return (name: IpcChannel, ...args: unknown[]) => handlers.get(name)!(undefined, ...args)
}
async function tool(run: TaskRun) {
  return repo.createToolExecution({ taskRunId: run.id, generation: run.generation, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'echo', args: [] } })
}

it('persists Channel speaker mode, override/default scheduler and bounded turn count through named IPC', async () => {
  const invoke = ipc()
  expect(await invoke(IpcChannel.ChannelConfigure, { channelId, speakerMode: 'manual', maxTurns: 12, schedulerModelConfigId: modelId })).toMatchObject({ speakerMode: 'manual', maxTurns: 12, schedulerModelConfigId: modelId })
  await invoke(IpcChannel.ChannelConfigure, { channelId, speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null })
  expect(await repo.getChannel(channelId)).toMatchObject({ speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null })
  for (const maxTurns of [0, 101, 1.5, '20']) await expect(invoke(IpcChannel.ChannelConfigure, { channelId, speakerMode: 'automatic', maxTurns, schedulerModelConfigId: null })).rejects.toThrow('配置无效')
  await expect(invoke(IpcChannel.ChannelConfigure, { channelId, speakerMode: 'parallel', maxTurns: 30, schedulerModelConfigId: null })).rejects.toThrow('配置无效')
  await expect(invoke(IpcChannel.ChannelConfigure, { channelId, speakerMode: 'manual', maxTurns: 30, schedulerModelConfigId: 'missing' })).rejects.toThrow('不存在')
  expect(await repo.getChannel(channelId)).toMatchObject({ speakerMode: 'automatic', maxTurns: 30 })
})

it.each(['running', 'cancelling', 'paused', 'queued'] as const)('rejects deletion of %s Run and retains facts', async (status) => {
  const run = await start()
  db.db.update(taskRuns).set({ status }).where(eq(taskRuns.id, run.id)).run()
  await expect(repo.removeChannel(channelId)).rejects.toThrow('未结束任务')
  expect(await repo.getChannel(channelId)).toBeDefined()
  expect(await repo.listMessages(channelId)).toHaveLength(1)
  expect(await repo.listTaskRunEvents(run.id)).toHaveLength(1)
})

it.each(['pending', 'approved'] as const)('rejects %s approval even with terminal Run/tool records', async (status) => {
  const run = await start(); const execution = await tool(run)
  const approval = await repo.createApprovalRequest(execution.id, '2099-01-01T00:00:00Z')
  db.db.update(approvalRequests).set({ status }).where(eq(approvalRequests.id, approval.id)).run()
  db.db.update(toolExecutions).set({ status: 'completed' }).where(eq(toolExecutions.id, execution.id)).run()
  terminal(run)
  await expect(repo.removeChannel(channelId)).rejects.toThrow('审批')
  expect(await repo.getApprovalRequest(approval.id)).toMatchObject({ status })
})

it('retains a nonterminal Agent Turn even if its Run already appears completed', async () => {
  const run = await start()
  await repo.startSingleMemberTurn(run.id, run.generation)
  terminal(run)
  await expect(repo.removeChannel(channelId)).rejects.toThrow('未结束任务')
  expect(await repo.listAgentTurns(run.id)).toHaveLength(1)
})

it.each(['executing', 'waiting_approval', 'process_recovery'] as const)('rejects a terminal Run with %s tool facts', async (state) => {
  const run = await start(); const execution = await tool(run)
  db.db.update(toolExecutions).set(state === 'process_recovery' ? { status: 'failed', processRecoveryRequired: true } : { status: state }).where(eq(toolExecutions.id, execution.id)).run()
  terminal(run)
  await expect(repo.removeChannel(channelId)).rejects.toThrow('操作、审批或恢复')
  expect(await repo.getToolExecution(execution.id)).toBeDefined()
})

it.each(['preparing', 'staged', 'publishing', 'effect_claimed', 'published', 'cleanup_pending', 'needs_recovery'] as const)('retains %s overwrite journal after terminal Run/tool', async (state) => {
  const run = await start(); const execution = await tool(run)
  db.db.update(toolExecutions).set({ status: 'completed' }).where(eq(toolExecutions.id, execution.id)).run()
  db.db.insert(overwritePublications).values({ executionId: execution.id, temporaryRelativePath: '.tmp', backupRelativePath: '.backup', temporaryIdentityJson: null, state, createdAt: '', updatedAt: '' }).run()
  terminal(run)
  await expect(repo.removeChannel(channelId)).rejects.toThrow('恢复')
  expect(await repo.getTaskRun(run.id)).toBeDefined()
})

it('requires explicit confirmation and waits for in-memory effects despite terminal records', async () => {
  const run = await start(); terminal(run)
  let finish!: () => void
  const pending = tasks.trackEffect(run.id, () => new Promise<void>((resolve) => { finish = resolve }))
  await Promise.resolve()
  const invoke = ipc()
  await expect(invoke(IpcChannel.ChannelRemove, { channelId })).rejects.toThrow('确认')
  await expect(invoke(IpcChannel.ChannelRemove, { channelId, confirmation: 'delete_channel_records' })).rejects.toThrow('清理')
  finish(); await pending
  await invoke(IpcChannel.ChannelRemove, { channelId, confirmation: 'delete_channel_records' })
  expect(await repo.getChannel(channelId)).toBeUndefined()
})

it.each(['completed', 'failed'] as const)('deletes only safe Channel records after %s effect and preserves project, Agents and other Channel', async (status) => {
  const other = await repo.createChannel({ projectId, name: 'keep' })
  const run = await start(); const execution = await tool(run)
  const approval = await repo.createApprovalRequest(execution.id, '2099-01-01T00:00:00Z')
  // Successful effects retain executing approval history; terminal ToolExecution is authoritative.
  db.db.update(approvalRequests).set({ status: 'executing' }).where(eq(approvalRequests.id, approval.id)).run()
  db.db.update(toolExecutions).set({ status }).where(eq(toolExecutions.id, execution.id)).run()
  db.db.insert(overwritePublications).values({ executionId: execution.id, temporaryRelativePath: '.tmp', backupRelativePath: '.backup', temporaryIdentityJson: null, state: 'completed', createdAt: '', updatedAt: '' }).run()
  terminal(run)
  await ipc()(IpcChannel.ChannelRemove, { channelId, confirmation: 'delete_channel_records' })
  expect(await repo.listChannels(projectId)).toEqual([other])
  expect(await repo.getTaskRun(run.id)).toBeUndefined()
  expect(await repo.getToolExecution(execution.id)).toBeUndefined()
  expect(await repo.getApprovalRequest(approval.id)).toBeUndefined()
  expect(await repo.listMessages(channelId)).toEqual([])
  expect(await repo.listTaskRunEvents(run.id)).toEqual([])
  expect(await repo.listAuditEvents(channelId)).toEqual([])
  expect(await repo.getAgent(agent.id)).toEqual(agent)
  expect(await repo.listProjects()).toEqual([expect.objectContaining({ workspacePath: 'C:/keep-workspace' })])
})

it('narrows a member override, invalidates its old approval, and cannot grant Agent-denied permissions', async () => {
  const run = await start(); const execution = await tool(run)
  const approval = await repo.createApprovalRequest(execution.id, '2099-01-01T00:00:00Z')
  const before = (await repo.listChannelAgents(channelId))[0]
  const service = createAgentService(repo)
  const narrowed = await service.saveChannelAgent({ ...before, toolPermissionsOverride: { read_file: true, run_process: false } })
  expect(narrowed.revision).not.toBe(before.revision)
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'cancelled' })
  expect(await repo.getApprovalRequest(approval.id)).toMatchObject({ status: 'cancelled' })
  await expect(repo.createToolExecution({ taskRunId: run.id, generation: run.generation, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'echo', args: [] } })).rejects.toThrow()
  await expect(service.saveChannelAgent({ ...narrowed, toolPermissionsOverride: { search_files: true } })).rejects.toThrow('不能超出')
})
