import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createSerialOrchestrator, loopPauseReason } from '../../electron/core/serial-orchestrator'
import { createSingleAgentRunner } from '../../electron/core/single-agent-runner'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createApprovalService } from '../../electron/core/approval-service'
import { createProcessToolService } from '../../electron/core/process-tool-service'
import * as processTools from '../../electron/core/process-tool'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { Agent } from '../../shared/types'

let directory: string
let db: DatabaseClient
let repo: Repositories
let channelId: string
let projectId: string
let modelConfigId: string
let agent: Agent
let tasks: ReturnType<typeof createTaskRunService>
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'agent-team-controls-'))
  db = createDatabase({ filePath: join(directory, 'test.sqlite') }); repo = createRepositories(db)
  tasks = createTaskRunService(repo, 10)
  const created = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: directory })
  channelId = created.channel.id; projectId = created.project.id
  modelConfigId = (await repo.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'key' })).id
  agent = await repo.createAgent({ name: 'Alpha', avatar: null, title: '', systemPrompt: 'A', modelConfigId, defaultToolPermissions: { run_process: true, write_file: true } })
  await repo.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); rmSync(directory, { recursive: true, force: true }) })
const start = () => tasks.startTaskRun(channelId, modelConfigId, 'goal')
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r }); return { promise, resolve } }

it('holds cancelling lease and fences chunks until the registered effect finishes', async () => {
  const run = await start(); const effect = deferred(); const pending = tasks.trackEffect(run.id, () => effect.promise)
  const cancel = tasks.cancelTaskRun(run.id)
  await Promise.resolve(); await Promise.resolve()
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'cancelling', generation: run.generation + 1 })
  expect(await tasks.canAcceptChunk(run.id, run.generation)).toBe(false)
  await expect(start()).rejects.toThrow('继续或结束')
  effect.resolve(); await pending
  expect(await cancel).toMatchObject({ status: 'cancelled' })
  expect(await start()).toMatchObject({ status: 'running' })
})

it('surfaces cleanup timeout as paused and blocks resume/new send until cleanup is confirmed', async () => {
  const run = await start(); const effect = deferred(); const pending = tasks.trackEffect(run.id, () => effect.promise)
  expect(await tasks.cancelTaskRun(run.id)).toMatchObject({ status: 'paused', pauseReason: 'effect_cleanup_pending' })
  await expect(tasks.resumeTaskRun(run.id)).rejects.toThrow('清理')
  expect((await ipc().invoke(IpcChannel.TaskRunSnapshot, channelId)).resumeAllowed[run.id]).toBe(false)
  await expect(start()).rejects.toThrow('继续或结束')
  effect.resolve(); await pending
  expect(await tasks.cancelTaskRun(run.id)).toMatchObject({ status: 'cancelled' })
})

it.each(['rejected', 'expired'])('requires explicit continuation after approval is %s and starts a fresh generation/Turn', async (decision) => {
  const run = await start(); const turn = (await repo.startSingleMemberTurn(run.id, run.generation))!
  let approvalNow = new Date()
  const approvals = createApprovalService(repo, () => approvalNow)
  const engine = createToolEngine(repo, approvals)
  const execution = (await engine.execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'x', args: [] } })).execution
  await repo.markAgentTurnWaiting(turn.id, execution.id)
  expect((await repo.getChannelTaskSnapshot(channelId)).resumeAllowed[run.id]).toBe(false)
  await expect(tasks.resumeTaskRun(run.id)).rejects.toThrow('未完成')
  const approval = (await repo.getApprovalForToolExecution(execution.id))!
  if (decision === 'rejected') await approvals.reject(approval.id, approval.requestHash)
  else { approvalNow = new Date(approvalNow.getTime() + 6 * 60 * 1000); await approvals.expire(approval.id) }
  expect((await repo.getChannelTaskSnapshot(channelId)).resumeAllowed[run.id]).toBe(true)
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'running', generation: run.generation, currentTurnId: turn.id })
  const resumed = await tasks.resumeTaskRun(run.id)
  expect(resumed).toMatchObject({ status: 'running', generation: run.generation + 1, turnCount: 2 })
  expect(resumed.currentTurnId).not.toBe(turn.id)
  await expect(engine.execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id }, { toolName: 'write_file', input: { path: 'late.txt', content: 'late' } })).rejects.toThrow('失效')
})

it('pauses both running/cancelling after restart without replaying a claimed process', async () => {
  const run = await start(); const turn = (await repo.startSingleMemberTurn(run.id, run.generation))!
  await repo.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '[]' })
  const approvals = createApprovalService(repo); const engine = createToolEngine(repo, approvals)
  const execution = (await engine.execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'echo', args: [] } })).execution
  const approval = (await repo.getApprovalForToolExecution(execution.id))!
  await approvals.approve(approval.id, approval.requestHash)
  await repo.claimApprovedProcess(approval.id, new Date().toISOString())
  await repo.beginTaskRunCancellation(run.id)
  db.close(); db = createDatabase({ filePath: join(directory, 'test.sqlite') }); repo = createRepositories(db); tasks = createTaskRunService(repo, 10)
  expect(await repo.recoverRunningTaskRuns()).toBe(1)
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused', generation: run.generation + 2 })
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'executing' })
  await expect(tasks.resumeTaskRun(run.id, agent.id)).rejects.toThrow('未完成')
  expect(await tasks.cancelTaskRun(run.id)).toMatchObject({ status: 'paused', pauseReason: 'effect_cleanup_pending' })
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ processRecoveryRequired: true })
  const { invoke } = ipc()
  await expect(invoke(IpcChannel.TaskRunAcknowledgeProcessRecovery, run.id, execution.id, 'unchecked')).rejects.toThrow('确认')
  await expect(tasks.acknowledgeProcessRecovery(run.id, 'unknown')).rejects.toThrow('不可用')
  const effect = deferred(); const pending = tasks.trackEffect(run.id, () => effect.promise)
  await expect(tasks.acknowledgeProcessRecovery(run.id, execution.id)).rejects.toThrow('清理')
  effect.resolve(); await pending
  await invoke(IpcChannel.TaskRunAcknowledgeProcessRecovery, run.id, execution.id, 'manually_stopped_and_verified')
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'cancelled', processRecoveryRequired: false })
  expect((await repo.listAuditEvents(channelId)).find((item) => item.eventType === 'process_recovery_acknowledged')?.metadataJson).toContain('"osStateVerifiedByApplication":false')
  await expect(tasks.acknowledgeProcessRecovery(run.id, execution.id)).rejects.toThrow('不可用')
  await invoke(IpcChannel.TaskRunTerminate, run.id)
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'cancelled' })
})

it('requires a restart marker before manual process recovery and can resume after acknowledgment', async () => {
  const run = await start(); const turn = (await repo.startSingleMemberTurn(run.id, run.generation))!
  await repo.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '[]' })
  const approvals = createApprovalService(repo)
  const execution = (await createToolEngine(repo, approvals).execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'echo', args: [] } })).execution
  const approval = (await repo.getApprovalForToolExecution(execution.id))!
  await approvals.approve(approval.id, approval.requestHash)
  await repo.claimApprovedProcess(approval.id, new Date().toISOString())
  await expect(tasks.acknowledgeProcessRecovery(run.id, execution.id)).rejects.toThrow('不可用')
  await tasks.cancelTaskRun(run.id)
  await expect(tasks.acknowledgeProcessRecovery(run.id, execution.id)).rejects.toThrow('不可用')
  // Restart recovery must also discover a Run already paused by a cleanup timeout.
  expect(await repo.recoverRunningTaskRuns()).toBe(0)
  await tasks.acknowledgeProcessRecovery(run.id, execution.id)
  expect(await tasks.resumeTaskRun(run.id, agent.id)).toMatchObject({ status: 'running' })
  expect(await repo.getApprovalRequest(approval.id)).toMatchObject({ status: 'cancelled' })
})

it('keeps a spawned process error unresolved through cancellation until late close', async () => {
  vi.useFakeTimers()
  const run = await start(); const turn = (await repo.startSingleMemberTurn(run.id, run.generation))!
  await repo.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '[]' })
  const approvals = createApprovalService(repo)
  const execution = (await createToolEngine(repo, approvals).execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'echo', args: [] } })).execution
  const approval = (await repo.getApprovalForToolExecution(execution.id))!
  await approvals.approve(approval.id, approval.requestHash)
  const child = Object.assign(new EventEmitter(), { pid: 123, stderr: new EventEmitter(), kill: vi.fn(() => { child.emit('error', new Error('kill failed')); return false }) })
  const execute = processTools.executeRegisteredProcess
  vi.spyOn(processTools, 'executeRegisteredProcess').mockImplementation((options) => execute({ ...options, spawnProcess: vi.fn(() => child) as any }))
  const pending = createProcessToolService(repo, tasks).runApproved(approval.id)
  await vi.advanceTimersByTimeAsync(0)
  const cancellation = tasks.cancelTaskRun(run.id)
  await vi.advanceTimersByTimeAsync(11)
  expect(await cancellation).toMatchObject({ status: 'paused', pauseReason: 'effect_cleanup_pending' })
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'executing' })
  await expect(tasks.resumeTaskRun(run.id)).rejects.toThrow('清理')
  child.emit('close', null); await pending
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'cancelled' })
  expect(await tasks.cancelTaskRun(run.id)).toMatchObject({ status: 'cancelled' })
})

function ipc() {
  const handlers = new Map<string, any>()
  const orchestrator = { run: vi.fn().mockResolvedValue(undefined) }
  registerHandlers({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showOpenDialog: vi.fn() }, repositories: repo, taskRuns: tasks,
    modelClient: { requireCloudConsent: vi.fn().mockResolvedValue(undefined) } as any, orchestrator })
  const event = { sender: { isDestroyed: () => false, send: vi.fn() } }
  return { invoke: (name: IpcChannel, ...args: any[]) => handlers.get(name)(event, ...args), orchestrator }
}
it('validates CEO interruption before cancelling and allows only one competing send', async () => {
  const run = await start(); const { invoke } = ipc()
  await expect(invoke(IpcChannel.TaskRunInterrupt, run.id, { channelId, modelConfigId, content: '@Alpha', mentions: [{ agentId: 'forged', start: 0, end: 6, text: '@Alpha' }] })).rejects.toThrow('提及')
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'running', generation: 0 })
  const input = { channelId, modelConfigId, content: 'replacement' }
  const results = await Promise.allSettled([invoke(IpcChannel.TaskRunInterrupt, run.id, input), invoke(IpcChannel.TaskRunInterrupt, run.id, input)])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const runs = await repo.listTaskRuns(channelId)
  expect(runs.map((item) => item.status).sort()).toEqual(['cancelled', 'running'])
  expect((await repo.listMessages(channelId)).map((item) => item.content)).toEqual(['goal', 'replacement'])
})

it('assigns only current enabled members through the named API and terminates paused runs', async () => {
  const run = await start(); await repo.pauseTaskRun(run.id, 'manual_selection')
  const { invoke, orchestrator } = ipc()
  await expect(invoke(IpcChannel.TaskRunAssign, run.id, 'unknown')).rejects.toThrow('资格')
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused' })
  await invoke(IpcChannel.TaskRunAssign, run.id, agent.id)
  expect(orchestrator.run).toHaveBeenCalledOnce()
  const fresh = (await repo.getTaskRun(run.id))!
  expect(fresh).toMatchObject({ status: 'running', generation: 2, turnCount: 1 })
  await invoke(IpcChannel.TaskRunTerminate, run.id)
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'cancelled' })
})

it('pauses a 120-second Agent call and drops its late result', async () => {
  vi.useFakeTimers()
  const run = await start(); let release!: (value: any) => void
  const runner = { resolveAgent: async () => ({ agent, modelConfigId, memberRevision: 'test' }), run: vi.fn(() => new Promise<any>((resolve) => { release = resolve })) }
  const modelClient: any = { requireCloudConsent: vi.fn().mockResolvedValue(undefined) }
  const orchestrator = createSerialOrchestrator({ repositories: repo, taskRuns: tasks, runner, modelClient })
  const pending = orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  await vi.advanceTimersByTimeAsync(120_001); await pending
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused', pauseReason: 'Agent 调用超过 120 秒，等待 CEO 处理' })
  release({ status: 'completed', content: 'late' }); await Promise.resolve()
  expect(await repo.listMessages(channelId)).toHaveLength(1)
})

it('enforces the Channel turn limit and pauses three same-speaker Turns', async () => {
  expect(loopPauseReason(['A', 'A'])).toBeUndefined()
  expect(loopPauseReason(['A', 'A', 'A'])).toContain('连续')
  expect(loopPauseReason(Array.from({ length: 11 }, (_, i) => i % 2 ? 'B' : 'A'))).toBeUndefined()
  expect(loopPauseReason(Array.from({ length: 12 }, (_, i) => i % 2 ? 'B' : 'A'))).toContain('交替')
  db.db.run(sql`UPDATE channels SET max_turns = 1 WHERE id = ${channelId}`)
  const run = await start()
  const modelClient: any = { requireCloudConsent: vi.fn().mockResolvedValue(undefined), streamChat: async (_input: any, emit: any) => { await emit({ type: 'delta', content: 'done' }); await emit({ type: 'complete' }) } }
  const runner = createSingleAgentRunner({ repositories: repo, taskRuns: tasks, modelClient, toolEngine: createToolEngine(repo) })
  await createSerialOrchestrator({ repositories: repo, taskRuns: tasks, modelClient, runner }).run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 1, pauseReason: 'Agent 轮次已达到群聊上限' })
  await expect(tasks.resumeTaskRun(run.id, agent.id)).rejects.toThrow('上限')
})

it('pauses a 60-second tool without claiming cancellation until its effect is fenced', async () => {
  vi.useFakeTimers()
  const run = await start(); const gate = deferred(); let effects = 0
  const toolEngine: any = { execute: async (context: any, request: any) => {
    const execution = await repo.createToolExecution(context, request)
    await gate.promise
    return { execution: await repo.finishToolExecution(execution.id, () => { effects++; return { status: 'completed', riskLevel: 'medium', resultSummary: 'created' } }) }
  } }
  const modelClient: any = { requireCloudConsent: vi.fn().mockResolvedValue(undefined), streamChat: async (_input: any, emit: any) => {
    await emit({ type: 'tool_call', toolCall: { index: 0, id: 'call', name: 'write_file', arguments: JSON.stringify({ path: 'late.txt', content: 'late' }) } })
    await emit({ type: 'complete' })
  } }
  const runner = createSingleAgentRunner({ repositories: repo, taskRuns: tasks, modelClient, toolEngine })
  const pending = createSerialOrchestrator({ repositories: repo, taskRuns: tasks, modelClient, runner }).run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  await vi.advanceTimersByTimeAsync(60_011); await pending
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused', pauseReason: 'effect_cleanup_pending' })
  await expect(tasks.resumeTaskRun(run.id)).rejects.toThrow('清理')
  gate.resolve(); await vi.advanceTimersByTimeAsync(0)
  expect(effects).toBe(0)
  expect((await repo.listToolExecutions(run.id))[0].status).toBe('cancelled')
  const fresh = await tasks.resumeTaskRun(run.id)
  expect(fresh.generation).toBeGreaterThan(run.generation)
  expect(fresh.currentTurnId).not.toBeNull()
})

it('keeps a timed-out approved process unresolved until close, then permits termination', async () => {
  vi.useFakeTimers()
  const run = await start(); const turn = (await repo.startSingleMemberTurn(run.id, run.generation))!
  await repo.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '[]' })
  const approvals = createApprovalService(repo)
  const execution = (await createToolEngine(repo, approvals).execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id }, { toolName: 'run_process', input: { executableId: 'echo', args: [] } })).execution
  await repo.markAgentTurnWaiting(turn.id, execution.id)
  const approval = (await repo.getApprovalForToolExecution(execution.id))!
  await approvals.approve(approval.id, approval.requestHash)
  const gate = deferred(); let signal!: AbortSignal
  vi.spyOn(processTools, 'executeRegisteredProcess').mockImplementation(async (options) => { signal = options.signal; await gate.promise; return { exitCode: null, stderr: '' } })
  const pending = createProcessToolService(repo, tasks).runApproved(approval.id)
  await vi.advanceTimersByTimeAsync(60_011)
  expect(signal.aborted).toBe(true)
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused', pauseReason: 'effect_cleanup_pending' })
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'executing' })
  await expect(tasks.resumeTaskRun(run.id)).rejects.toThrow('清理')
  gate.resolve(); await pending
  expect(await repo.getToolExecution(execution.id)).toMatchObject({ status: 'cancelled' })
  expect(await tasks.cancelTaskRun(run.id)).toMatchObject({ status: 'cancelled' })
})

it('pauses actual automatic scheduling after three consecutive same-Agent Turns', async () => {
  const second = await repo.createAgent({ name: 'Beta', avatar: null, title: '', systemPrompt: 'B', modelConfigId, defaultToolPermissions: {} })
  await repo.saveChannelAgent({ channelId, agentId: second.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await repo.setChannelScheduler(channelId, modelConfigId)
  const run = await tasks.startTaskRun(channelId, modelConfigId, '@Alpha', [{ agentId: agent.id, start: 0, end: 6, text: '@Alpha' }])
  const modelClient: any = { requireCloudConsent: vi.fn().mockResolvedValue(undefined), selectSpeaker: vi.fn().mockResolvedValue(JSON.stringify({ nextSpeaker: agent.id, reason: 'work remains' })),
    streamChat: vi.fn(async (_input: any, emit: any) => { await emit({ type: 'delta', content: 'work' }); await emit({ type: 'complete' }) }) }
  const runner = createSingleAgentRunner({ repositories: repo, taskRuns: tasks, modelClient, toolEngine: createToolEngine(repo) })
  await createSerialOrchestrator({ repositories: repo, taskRuns: tasks, modelClient, runner }).run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repo.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 3, pauseReason: '同一 Agent 连续发言 3 轮，等待 CEO 处理' })
  expect(modelClient.streamChat).toHaveBeenCalledTimes(3)
  expect(modelClient.selectSpeaker).toHaveBeenCalledTimes(2)
})
