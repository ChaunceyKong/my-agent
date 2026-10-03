import { expect, it, vi } from 'vitest'
import { createExecutionGate } from '../../electron/core/execution-gate'
import { createUpdateService, type UpdateAdapter } from '../../electron/core/update-service'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createProcessToolService } from '../../electron/core/process-tool-service'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createApprovedOverwriteService } from '../../electron/core/approved-overwrite-service'
import { createSingleAgentRunner } from '../../electron/core/single-agent-runner'
import { createSerialOrchestrator } from '../../electron/core/serial-orchestrator'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { Repositories } from '../../electron/database/repositories'

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture(hasBarriers = vi.fn(async () => false)) {
  const gate = createExecutionGate()
  let progress!: (value: number) => void; let error!: () => void; let quitCancelled!: () => void
  const adapter: UpdateAdapter = { check: vi.fn(async () => true), download: vi.fn(async () => {}), install: vi.fn(() => true),
    onProgress: (listener) => { progress = listener }, onError: (listener) => { error = listener }, onQuitCancelled: (listener) => { quitCancelled = listener } }
  const service = createUpdateService({ gate, adapter, hasBarriers, hasEffects: () => false })
  const downloaded = async () => { await service.check(); await service.download() }
  return { gate, adapter, service, downloaded, progress: (value: number) => progress(value), error: () => error(), quitCancelled: () => quitCancelled() }
}

it('disabled actions never touch adapter or barriers', async () => {
  for (const reason of ['development', 'portable', 'unsupported', 'unconfigured', 'signing-unavailable'] as const) {
    const adapter = { check: vi.fn(), download: vi.fn(), install: vi.fn(), onProgress: vi.fn(), onError: vi.fn(), onQuitCancelled: vi.fn() }
    const barrier = vi.fn()
    const service = createUpdateService({ gate: createExecutionGate(), disabledReason: reason, adapter, hasBarriers: barrier, hasEffects: () => false })
    for (const action of [service.check, service.download, service.install, service.cancel]) expect(await action()).toMatchObject({ state: 'disabled', reason })
    expect(adapter.check).not.toHaveBeenCalled(); expect(adapter.download).not.toHaveBeenCalled(); expect(adapter.install).not.toHaveBeenCalled(); expect(barrier).not.toHaveBeenCalled()
  }
})

it('serializes explicit actions and bounds progress without exposing metadata', async () => {
  const f = fixture(); const wait = deferred<void>()
  await expect(f.service.download()).rejects.toThrow('检查')
  await f.service.check(); vi.mocked(f.adapter.download).mockReturnValue(wait.promise)
  const download = f.service.download()
  await expect(f.service.check()).rejects.toThrow('正在执行')
  f.progress(-100); expect(f.service.status().progress).toBe(0)
  f.progress(Infinity); expect(f.service.status().progress).toBe(0)
  f.progress(101); expect(f.service.status().progress).toBe(100)
  wait.resolve(); await download
  f.progress(2); expect(f.service.status().state).toBe('downloaded')
  expect(Object.keys(f.service.status())).toEqual(['state', 'reason', 'progress', 'cancellable'])
})

it('rejects install immediately for already accepted operations before their first await settles', async () => {
  const barriers = vi.fn(async () => false); const f = fixture(barriers); await f.downloaded()
  const wait = deferred<void>(); const operation = f.gate.protect(() => wait.promise)()
  expect((await f.service.install()).reason).toBe('busy'); expect(barriers).not.toHaveBeenCalled(); expect(f.adapter.install).not.toHaveBeenCalled()
  wait.resolve(); await operation
  expect((await f.service.install()).state).toBe('install-pending'); expect(f.gate.isPending()).toBe(true)
})

it('blocks admissions throughout final global query and delayed exit without terminating tasks', async () => {
  const wait = deferred<boolean>(); const f = fixture(vi.fn(() => wait.promise)); await f.downloaded()
  const install = f.service.install()
  expect(f.service.status()).toMatchObject({ state: 'install-pending', cancellable: true })
  expect(() => f.gate.reserve()).toThrow('更新安装')
  wait.resolve(false); await install
  expect(() => f.gate.reserve()).toThrow('更新安装')
  await expect(f.service.cancel()).rejects.toThrow('不可取消')
  f.progress(20); expect(f.service.status().state).toBe('install-pending')
  expect(f.adapter.install).toHaveBeenCalledTimes(1)
})

it.each(['async-error', 'quit-cancelled', 'unknown-throw'] as const)('retains gate after handoff when %s cannot prove installer work was undone', async (kind) => {
  const f = fixture(); await f.downloaded()
  if (kind === 'unknown-throw') vi.mocked(f.adapter.install).mockImplementation(() => { throw new Error('PRIVATE') })
  await f.service.install()
  if (kind === 'async-error') f.error()
  if (kind === 'quit-cancelled') f.quitCancelled()
  expect(f.service.status()).toMatchObject({ state: 'install-pending', reason: 'handoff-unconfirmed', cancellable: false })
  expect(() => f.gate.reserve()).toThrow('更新安装')
})

it('only releases gate for proven no-handoff false result, even with synchronous error', async () => {
  const f = fixture(); await f.downloaded()
  vi.mocked(f.adapter.install).mockImplementation(() => { f.error(); expect(() => f.gate.reserve()).toThrow(); return false })
  expect((await f.service.install()).state).toBe('error')
  expect(f.gate.isPending()).toBe(false); f.gate.reserve()()
})

it('query errors/barriers and memory effects never hand off and preserve durable state', async () => {
  for (const outcome of ['barrier', 'error', 'memory'] as const) {
    const f = fixture(vi.fn(async () => { if (outcome === 'error') throw new Error('PRIVATE'); return outcome === 'barrier' }))
    const service = outcome === 'memory' ? createUpdateService({ gate: f.gate, adapter: f.adapter, hasBarriers: async () => false, hasEffects: () => true }) : f.service
    await service.check(); await service.download(); await service.install()
    expect(f.adapter.install).not.toHaveBeenCalled(); expect(f.gate.isPending()).toBe(false)
    expect(service.status().reason).toBe(outcome === 'error' ? 'failed' : 'barriers')
  }
})

it('cancelled old preflight rejection cannot unlock or corrupt a newer installation', async () => {
  const old = deferred<boolean>(); const current = deferred<boolean>()
  const barriers = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const f = fixture(barriers); await f.downloaded()
  const a = f.service.install(); await f.service.cancel(); const b = f.service.install()
  old.reject(new Error('PRIVATE')); await a
  expect(f.service.status()).toMatchObject({ state: 'install-pending', cancellable: true })
  expect(() => f.gate.reserve()).toThrow('更新安装')
  current.resolve(false); await b; expect(f.adapter.install).toHaveBeenCalledTimes(1)
  expect(() => f.gate.reserve()).toThrow('更新安装')
})

it('late download error during preflight cannot unlock then resume handoff', async () => {
  const wait = deferred<boolean>(); const f = fixture(vi.fn(() => wait.promise)); await f.downloaded()
  const install = f.service.install(); f.error()
  expect(f.gate.isPending()).toBe(true)
  wait.resolve(false); await install
  expect(f.gate.isPending()).toBe(true)
})

it('cancelled successful preflight never installs and its finalizer cannot clear new action', async () => {
  const wait = deferred<boolean>(); const f = fixture(vi.fn(() => wait.promise)); await f.downloaded()
  const install = f.service.install(); await f.service.cancel(); wait.resolve(false); await install
  expect(f.adapter.install).not.toHaveBeenCalled(); expect(f.gate.isPending()).toBe(false)
})

it('core entrypoints reserve before preclaim reads and reject before effects under pending gate', async () => {
  const gate = createExecutionGate(); const preclaim = deferred<undefined>()
  const repo = { getApprovalRequest: vi.fn(() => preclaim.promise), createStartedTaskRun: vi.fn(), resumeTaskRun: vi.fn(), createToolExecution: vi.fn(), claimApprovedOverwrite: vi.fn() } as unknown as Repositories
  const runs = createTaskRunService(repo, 10, gate)
  const processes = createProcessToolService(repo, runs, undefined, gate)
  const accepted = processes.runApproved('approval'); expect(() => gate.beginInstall()).toThrow('仍有操作')
  preclaim.resolve(undefined); await expect(accepted).rejects.toThrow('审批请求')
  const release = gate.beginInstall()
  await expect(processes.runApproved('approval')).rejects.toThrow('更新安装')
  await expect(runs.startTaskRun('c', 'm', 'hello')).rejects.toThrow('更新安装')
  await expect(runs.resumeTaskRun('r')).rejects.toThrow('更新安装')
  const effect = vi.fn(async () => {}); await expect(runs.trackEffect('r', effect)).rejects.toThrow('更新安装'); expect(effect).not.toHaveBeenCalled()
  await expect(createToolEngine(repo, undefined, gate).execute({ taskRunId: 'r', generation: 0, agentId: 'a' }, {})).rejects.toThrow('更新安装')
  await expect(createApprovedOverwriteService(repo, undefined, undefined, gate).runApproved('a')).rejects.toThrow('更新安装')
  const runner = createSingleAgentRunner({ repositories: repo, taskRuns: runs, modelClient: {} as never, toolEngine: {} as never, gate })
  await expect(runner.run({} as never)).rejects.toThrow('更新安装')
  await expect(createSerialOrchestrator({ repositories: repo, taskRuns: runs, modelClient: {} as never, runner, gate }).run({} as never)).rejects.toThrow('更新安装')
  expect(repo.createToolExecution).not.toHaveBeenCalled(); expect(repo.claimApprovedOverwrite).not.toHaveBeenCalled()
  release(); expect(runs.hasAnyActiveEffects()).toBe(false)
})

it('strict updater IPC denies every argument and mutation wrapper admits synchronously', async () => {
  const f = fixture(); const handlers = new Map<string, (...args: any[]) => any>()
  const pick = deferred<{ canceled: boolean; filePaths: string[] }>()
  registerHandlers({ repositories: {} as never, ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    dialog: { showOpenDialog: () => pick.promise }, gate: f.gate, updates: f.service })
  for (const channel of [IpcChannel.UpdateStatus, IpcChannel.UpdateCheck, IpcChannel.UpdateDownload, IpcChannel.UpdateInstall, IpcChannel.UpdateCancel]) {
    expect(() => handlers.get(channel)!({}, { feed: 'PRIVATE' })).toThrow('更新请求无效')
  }
  const accepted = handlers.get(IpcChannel.ProjectPickWorkspace)!({})
  expect(() => f.gate.beginInstall()).toThrow('仍有操作')
  pick.resolve({ canceled: true, filePaths: [] }); await accepted
  const release = f.gate.beginInstall()
  for (const channel of [IpcChannel.ProjectCreate, IpcChannel.ChannelConfigure, IpcChannel.ModelSave, IpcChannel.AgentCreate, IpcChannel.CloudConsentGrant,
    IpcChannel.ExecutableSave, IpcChannel.TemplateImport, IpcChannel.ChannelAgentSave, IpcChannel.ApprovalApprove, IpcChannel.ApprovalRunApproved,
    IpcChannel.MessageSend, IpcChannel.TaskRunContinue, IpcChannel.TaskRunInterrupt, IpcChannel.TaskRunAcknowledgeProcessRecovery, IpcChannel.DiagnosticsExport]) {
    expect(() => handlers.get(channel)!({})).toThrow('更新安装')
  }
  expect(handlers.get(IpcChannel.UpdateStatus)!({})).toMatchObject({ state: 'idle' })
  release()
})

it.each([IpcChannel.MessageSend, IpcChannel.TaskRunInterrupt, IpcChannel.TaskRunContinue, IpcChannel.TaskRunAssign])('accepted %s reserves before pre-DB await and rejects install', async (channel) => {
  const f = fixture(); await f.downloaded()
  const read = deferred<undefined>(); const handlers = new Map<string, (...args: any[]) => any>()
  const repo = { getChannel: vi.fn(() => read.promise), getTaskRun: vi.fn(() => read.promise) } as unknown as Repositories
  const runs = createTaskRunService(repo, 10, f.gate)
  registerHandlers({ repositories: repo, taskRuns: runs, modelClient: {} as never, ipcMain: { handle: (name, listener) => handlers.set(name, listener) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, gate: f.gate, updates: f.service })
  const input = { channelId: 'channel', modelConfigId: 'model', content: 'hello' }
  const args = channel === IpcChannel.MessageSend ? [input] : channel === IpcChannel.TaskRunInterrupt ? ['run', input] : channel === IpcChannel.TaskRunAssign ? ['run', 'agent'] : ['run']
  const accepted = handlers.get(channel)!({}, ...args)
  expect((await f.service.install()).reason).toBe('busy')
  expect(f.adapter.install).not.toHaveBeenCalled()
  read.resolve(undefined); await expect(accepted).rejects.toThrow()
  expect(f.gate.hasReservations()).toBe(false)
})

it('effect registration precedes microtask invocation and remains admitted through cleanup', async () => {
  const gate = createExecutionGate(); const runs = createTaskRunService({} as never, 10, gate)
  const wait = deferred<void>(); const effect = vi.fn(() => wait.promise)
  const pending = runs.trackEffect('run', effect)
  expect(effect).not.toHaveBeenCalled(); expect(runs.hasAnyActiveEffects()).toBe(true)
  expect(() => gate.beginInstall()).toThrow('仍有操作')
  await Promise.resolve(); expect(effect).toHaveBeenCalledTimes(1)
  wait.resolve(); await pending
  expect(runs.hasAnyActiveEffects()).toBe(false); expect(gate.hasReservations()).toBe(false)
})
