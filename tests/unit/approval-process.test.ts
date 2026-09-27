import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApprovalService } from '../../electron/core/approval-service'
import { executeRegisteredProcess } from '../../electron/core/process-tool'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: DatabaseClient
let repositories: Repositories
let context: { taskRunId: string; generation: number; agentId: string }
let now: Date

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-team-approval-'))
  db = createDatabase({ filePath: join(directory, 'db.sqlite') })
  repositories = createRepositories(db)
  const { channel } = await repositories.createProjectWithInitialChannel({ name: 'p', workspacePath: directory })
  const model = await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.com', modelName: 'm', encryptedApiKey: 'x' })
  const agent = await repositories.createAgent({ name: 'a', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id, defaultToolPermissions: { run_process: true } })
  await repositories.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const run = await repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'run' })
  context = { taskRunId: run.id, generation: run.generation, agentId: agent.id }
  now = new Date('2026-09-27T00:00:00.000Z')
})

afterEach(() => db.close())

it('creates an approval without executing a process, and approves only once', async () => {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  const outcome = await engine.execute(context, { toolName: 'run_process', input: { executableId: 'echo', args: ['ok'] } })
  expect(outcome.execution.status).toBe('waiting_approval')
  const approval = await repositories.getApprovalForToolExecution(outcome.execution.id)
  expect(approval).toMatchObject({ toolExecutionId: outcome.execution.id, status: 'pending', requestHash: outcome.execution.requestHash })
  expect(await service.approve(approval!.id, approval!.requestHash)).toMatchObject({ status: 'approved' })
  await expect(service.approve(approval!.id, approval!.requestHash)).rejects.toThrow('不可用')
})

it('fails closed for stale hash, expiry, and cancelled TaskRun', async () => {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  const execution = (await engine.execute(context, { toolName: 'run_process', input: { executableId: 'echo', args: ['ok'] } })).execution
  const id = (await repositories.getApprovalForToolExecution(execution.id))!.id
  await expect(service.approve(id, '0'.repeat(64))).rejects.toThrow('不可用')
  now = new Date(now.getTime() + 5 * 60 * 1000)
  expect(await service.approve(id, execution.requestHash)).toMatchObject({ status: 'expired' })
  const second = (await engine.execute(context, { toolName: 'run_process', input: { executableId: 'echo', args: ['ok'] } })).execution
  const secondId = (await repositories.getApprovalForToolExecution(second.id))!.id
  await createTaskRunService(repositories).cancelTaskRun(context.taskRunId)
  await expect(service.approve(secondId, second.requestHash)).rejects.toThrow('不可用')
})

it('rejects unknown executables and shell syntax before spawn', async () => {
  const signal = new AbortController().signal
  const spawn = vi.fn()
  await expect(executeRegisteredProcess({ executable: { id: 'missing', absolutePath: 'C:\\tool.exe', isEnabled: false, argumentPolicyJson: '["ok"]', createdAt: '', updatedAt: '' }, args: ['ok'], cwd: 'C:\\work', signal, spawnProcess: spawn as any })).rejects.toThrow('不可用')
  await repositories.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '["ok"]' })
  const registered = (await repositories.getRegisteredExecutable('echo'))!
  await expect(executeRegisteredProcess({ executable: registered, args: ['ok; whoami'], cwd: 'C:\\work', signal, spawnProcess: spawn as any })).rejects.toThrow('不可用')
  expect(spawn).not.toHaveBeenCalled()
})

it('kills a running process when the task cancellation signal aborts', async () => {
  const controller = new AbortController()
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn(), once: EventEmitter.prototype.once })
  const result = executeRegisteredProcess({ executable: { id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '["ok"]', createdAt: '', updatedAt: '' }, args: ['ok'], cwd: 'C:\\work', signal: controller.signal, spawnProcess: vi.fn(() => child) as any })
  controller.abort()
  await expect(result).resolves.toMatchObject({ exitCode: null, stderr: 'cancelled' })
  expect(child.kill).toHaveBeenCalledOnce()
})

it('rejects wildcard and dangerous Node, Python and Git argument policies', async () => {
  const signal = new AbortController().signal
  const spawn = vi.fn()
  for (const [path, args] of [
    ['C:\\node.exe', ['--eval', 'process.exit(0)']], ['C:\\Python.EXE', ['-c', 'print(1)']],
    ['C:\\git.exe', ['reset', '--hard']], ['C:\\tool.exe', ['*']],
    ['C:\\node.exe.', ['--eval', 'process.exit(0)']], ['C:\\node.exe ', ['--eval', 'process.exit(0)']],
    ['C:\\git.exe.', ['reset', '--hard']],
  ] as Array<[string, string[]]>) {
    await expect(executeRegisteredProcess({ executable: { id: 'x', absolutePath: path, isEnabled: true, argumentPolicyJson: JSON.stringify(args), createdAt: '', updatedAt: '' }, args, cwd: 'C:\\work', signal, spawnProcess: spawn as any })).rejects.toThrow('不可用')
  }
  expect(spawn).not.toHaveBeenCalled()
})

it('does not claim or spawn after approval when cancellation or policy revocation wins', async () => {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  await repositories.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '["ok"]' })
  const execution = (await engine.execute(context, { toolName: 'run_process', input: { executableId: 'echo', args: ['ok'] } })).execution
  const approval = (await repositories.getApprovalForToolExecution(execution.id))!
  await service.approve(approval.id, approval.requestHash)
  await createTaskRunService(repositories).cancelTaskRun(context.taskRunId)
  await expect(repositories.claimApprovedProcess(approval.id, now.toISOString())).rejects.toThrow('不可用')
  expect((await repositories.getApprovalRequest(approval.id))!.status).not.toBe('executing')
})

it('expires an approved request at claim time without a process side effect', async () => {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  await repositories.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '["ok"]' })
  const execution = (await engine.execute(context, { toolName: 'run_process', input: { executableId: 'echo', args: ['ok'] } })).execution
  const approval = (await repositories.getApprovalForToolExecution(execution.id))!
  await service.approve(approval.id, approval.requestHash)
  await expect(repositories.claimApprovedProcess(approval.id, new Date(now.getTime() + 5 * 60 * 1000).toISOString())).rejects.toThrow('过期')
  expect((await repositories.getApprovalRequest(approval.id))!.status).toBe('expired')
  expect((await repositories.getToolExecution(execution.id))!.status).toBe('cancelled')
})

it('allows exactly one concurrent process claim and leaves the loser without a failure audit', async () => {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  await repositories.saveRegisteredExecutable({ id: 'echo', absolutePath: 'C:\\tool.exe', isEnabled: true, argumentPolicyJson: '["ok"]' })
  const execution = (await engine.execute(context, { toolName: 'run_process', input: { executableId: 'echo', args: ['ok'] } })).execution
  const approval = (await repositories.getApprovalForToolExecution(execution.id))!
  await service.approve(approval.id, approval.requestHash)
  const claims = await Promise.allSettled([repositories.claimApprovedProcess(approval.id, now.toISOString()), repositories.claimApprovedProcess(approval.id, now.toISOString())])
  expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
  expect((await repositories.getApprovalRequest(approval.id))!.status).toBe('executing')
  expect((await repositories.getToolExecution(execution.id))!.status).toBe('executing')
  expect((await repositories.listAuditEvents((await repositories.getTaskRun(context.taskRunId))!.channelId)).filter((event) => event.eventType === 'tool_failed')).toEqual([])
})
