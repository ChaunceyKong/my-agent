import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApprovalService } from '../../electron/core/approval-service'
import { executeRegisteredProcess } from '../../electron/core/process-tool'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createProcessToolService } from '../../electron/core/process-tool-service'
import { createApprovedOverwriteService } from '../../electron/core/approved-overwrite-service'
import Database from 'better-sqlite3'
import { renameSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: DatabaseClient
let repositories: Repositories
let context: { taskRunId: string; generation: number; agentId: string }
let now: Date
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-team-approval-'))
  db = createDatabase({ filePath: join(directory, 'db.sqlite') })
  repositories = createRepositories(db)
  const { channel } = await repositories.createProjectWithInitialChannel({ name: 'p', workspacePath: directory })
  const model = await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.com', modelName: 'm', encryptedApiKey: 'x' })
  const agent = await repositories.createAgent({ name: 'a', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id, defaultToolPermissions: { run_process: true, write_file: true } })
  await repositories.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const run = await repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'run' })
  context = { taskRunId: run.id, generation: run.generation, agentId: agent.id }
  now = new Date('2026-09-27T00:00:00.000Z')
})

afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

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

it('binds an existing write to one immutable approval and writes only after explicit execution', async () => {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  const path = join(directory, 'draft.md')
  await writeFile(path, 'original')
  const execution = (await engine.execute(context, { toolName: 'write_file', input: { path: 'draft.md', content: 'replacement' } })).execution
  const approval = (await repositories.getApprovalForToolExecution(execution.id))!
  expect(execution).toMatchObject({ status: 'waiting_approval', riskLevel: 'high' })
  expect(approval).toMatchObject({ status: 'pending', requestHash: execution.requestHash, generation: execution.generation, policySnapshotJson: execution.policySnapshotJson })
  expect(await readFile(path, 'utf8')).toBe('original')
  expect(JSON.stringify(await repositories.listAuditEvents((await repositories.getTaskRun(context.taskRunId))!.channelId))).not.toMatch(/replacement|agent-team-approval-/)
  await service.approve(approval.id, approval.requestHash)
  expect(await readFile(path, 'utf8')).toBe('original')
  const tools = createProcessToolService(repositories, createTaskRunService(repositories), () => now)
  await tools.runApproved(approval.id)
  expect(await repositories.getToolExecution(execution.id)).toMatchObject({ status: 'completed' })
  expect(await readFile(path, 'utf8')).toBe('replacement')
  expect((await repositories.getToolExecution(execution.id))!.status).toBe('completed')
  await expect(tools.runApproved(approval.id)).rejects.toThrow('不可用')
})

it('does not overwrite after expiry, cancellation, policy revocation, or a stale target', async () => {
  const tools = createProcessToolService(repositories, createTaskRunService(repositories), () => now)
  const makeApproved = async (name: string) => {
    const service = createApprovalService(repositories, () => now)
    const engine = createToolEngine(repositories, service)
    const path = join(directory, `${name}.md`)
    await writeFile(path, 'original')
    const execution = (await engine.execute(context, { toolName: 'write_file', input: { path: `${name}.md`, content: 'replacement' } })).execution
    const approval = (await repositories.getApprovalForToolExecution(execution.id))!
    await service.approve(approval.id, approval.requestHash)
    return { path, execution, approval }
  }
  const expired = await makeApproved('expired')
  await expect(repositories.claimApprovedOverwrite(expired.approval.id, new Date(now.getTime() + 5 * 60 * 1000).toISOString(), '.agent-team-00000000-0000-0000-0000-000000000000.tmp', '.agent-team-00000000-0000-0000-0000-000000000000.backup')).rejects.toThrow('过期')
  expect(await readFile(expired.path, 'utf8')).toBe('original')

  const cancelled = await makeApproved('cancelled')
  await createTaskRunService(repositories).cancelTaskRun(context.taskRunId)
  await expect(tools.runApproved(cancelled.approval.id)).rejects.toThrow('不可用')
  expect(await readFile(cancelled.path, 'utf8')).toBe('original')

  const run = await repositories.getTaskRun(context.taskRunId)
  const next = await repositories.createStartedTaskRun({ channelId: run!.channelId, modelConfigId: run!.modelConfigId, content: 'next' })
  context = { ...context, taskRunId: next.id, generation: next.generation }
  const stale = await makeApproved('stale')
  await writeFile(stale.path, 'racer')
  await tools.runApproved(stale.approval.id)
  expect(await readFile(stale.path, 'utf8')).toBe('racer')
  expect((await repositories.getToolExecution(stale.execution.id))!.status).toBe('failed')

  const revoked = await makeApproved('revoked')
  await repositories.saveChannelAgent({ channelId: next.channelId, agentId: context.agentId, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await expect(tools.runApproved(revoked.approval.id)).rejects.toThrow('不可用')
  expect(await readFile(revoked.path, 'utf8')).toBe('original')
})

async function approvedWrite(name: string) {
  const service = createApprovalService(repositories, () => now)
  const engine = createToolEngine(repositories, service)
  const path = join(directory, `${name}.md`)
  await writeFile(path, 'original')
  const execution = (await engine.execute(context, { toolName: 'write_file', input: { path: `${name}.md`, content: 'replacement' } })).execution
  const approval = (await repositories.getApprovalForToolExecution(execution.id))!
  await service.approve(approval.id, approval.requestHash)
  return { path, execution, approval }
}

it('recovers a published replacement when final audit persistence fails', async () => {
  const item = await approvedWrite('audit')
  const sqlite = new Database(join(directory, 'db.sqlite'))
  sqlite.exec("CREATE TRIGGER reject_complete BEFORE INSERT ON audit_events WHEN NEW.event_type = 'tool_completed' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;")
  await createProcessToolService(repositories, createTaskRunService(repositories), () => now).runApproved(item.approval.id)
  expect(await readFile(item.path, 'utf8')).toBe('replacement')
  expect((await repositories.getToolExecution(item.execution.id))!.status).not.toBe('failed')
  expect(sqlite.prepare('SELECT state FROM overwrite_publications WHERE execution_id = ?').get(item.execution.id)).toEqual({ state: 'published' })
  sqlite.exec('DROP TRIGGER reject_complete'); sqlite.close()
  await createApprovedOverwriteService(repositories, () => now).recoverInterruptedPublications()
  expect((await repositories.getToolExecution(item.execution.id))!.status).toBe('completed')
  expect(await readdir(directory)).not.toContain(expect.stringMatching(/^\.agent-team-/))
})

it.each(['missing', 'racer'] as const)('recovers interrupted publishing without losing old data: %s', async (mode) => {
  const item = await approvedWrite(`interrupted-${mode}`)
  const temp = '.agent-team-00000000-0000-0000-0000-000000000001.tmp'
  const backup = '.agent-team-00000000-0000-0000-0000-000000000001.backup'
  await repositories.claimApprovedOverwrite(item.approval.id, now.toISOString(), temp, backup)
  const sqlite = new Database(join(directory, 'db.sqlite'))
  sqlite.prepare("UPDATE overwrite_publications SET state = 'publishing' WHERE execution_id = ?").run(item.execution.id)
  sqlite.close()
  renameSync(item.path, join(directory, backup))
  if (mode === 'racer') await writeFile(item.path, 'racer')
  await createApprovedOverwriteService(repositories, () => now).recoverInterruptedPublications()
  if (mode === 'missing') {
    expect(await readFile(item.path, 'utf8')).toBe('original')
    expect((await repositories.getToolExecution(item.execution.id))!.resultSummary).toContain('恢复')
  } else {
    expect(await readFile(item.path, 'utf8')).toBe('racer')
    expect((await repositories.getToolExecution(item.execution.id))!.resultSummary).toContain('人工恢复')
    expect(await readFile(join(directory, backup), 'utf8')).toBe('original')
  }
})

it('cleans temporary and backup artifacts only after a successful durable replacement', async () => {
  const item = await approvedWrite('cleanup')
  await createProcessToolService(repositories, createTaskRunService(repositories), () => now).runApproved(item.approval.id)
  expect(await readFile(item.path, 'utf8')).toBe('replacement')
  expect((await repositories.getToolExecution(item.execution.id))!.status).toBe('completed')
  expect((await readdir(directory)).filter((name) => name.startsWith('.agent-team-'))).toEqual([])
})
