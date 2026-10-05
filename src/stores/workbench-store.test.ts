import { afterEach, expect, it, vi } from 'vitest'
import { createWorkbenchStore } from './workbench-store'
import type { AgentTeamApi, Channel, ChannelTaskSnapshot, ModelConfigSummary, StreamEvent, TaskRun } from '../../shared/types'

const first: Channel = { id: 'c1', projectId: 'p', name: 'first', icon: null, speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null, createdAt: '', updatedAt: '' }
const second: Channel = { ...first, id: 'c2', name: 'second' }
const third: Channel = { ...first, id: 'c3', name: 'new' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function setup() {
  const api = {
    channels: { list: vi.fn().mockResolvedValue([first, second]), create: vi.fn().mockResolvedValue(third), remove: vi.fn().mockResolvedValue(undefined) },
    messages: { list: vi.fn().mockResolvedValue([]) }, tasks: { list: vi.fn().mockResolvedValue([]), snapshot: vi.fn(async (id: string) => ({ channel: [first, second, third].find((item) => item.id === id), resumeAllowed: {}, schedulerModelConfigId: null, agents: [], members: [], messages: [], runs: [], turns: [], events: [] })) },
  } as unknown as AgentTeamApi
  return { api, store: createWorkbenchStore(api) }
}

it('keeps a confirmed newly created Channel and its selection when deletion refresh returns an older same-project list', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const refresh = deferred<Channel[]>()
  vi.mocked(api.channels.list).mockReturnValueOnce(refresh.promise)
  const removing = store.removeChannel(first.id)
  await vi.waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2))
  await store.createChannel('new')
  expect(store.getSnapshot().channelId).toBe(third.id)
  refresh.resolve([second]); await removing
  expect(store.getSnapshot().channels).toEqual([second, third])
  expect(store.getSnapshot().channelId).toBe(third.id)
})

it('keeps a confirmed Channel configuration and uses current fallback when deletion refresh is stale', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const refresh = deferred<Channel[]>()
  vi.mocked(api.channels.list).mockReturnValueOnce(refresh.promise)
  const removing = store.removeChannel(first.id)
  await vi.waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2))
  const configured = { ...second, speakerMode: 'manual' as const, maxTurns: 12 }
  vi.mocked(api.tasks.snapshot).mockImplementation(async (id) => ({ channel: id === second.id ? configured : first, resumeAllowed: {}, schedulerModelConfigId: null, agents: [], members: [], messages: [], runs: [], turns: [], events: [] }))
  store.updateChannel(configured)
  refresh.resolve([second]); await removing
  expect(store.getSnapshot().channels).toEqual([configured])
  expect(store.getSnapshot().channelId).toBe(second.id)
})

it('does not reinsert a second deleted Channel from an earlier pending deletion refresh', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const refresh = deferred<Channel[]>()
  vi.mocked(api.channels.list).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce([])
  const removing = store.removeChannel(first.id)
  await vi.waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2))
  await store.removeChannel(second.id)
  refresh.resolve([second]); await removing
  expect(store.getSnapshot().channels).toEqual([])
  expect(store.getSnapshot().channelId).toBe('')
})

it('retains an explicitly switched Channel when a previously requested creation completes', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const creation = deferred<Channel>()
  vi.mocked(api.channels.create).mockReturnValueOnce(creation.promise)
  const creating = store.createChannel('new')
  await store.selectChannel(second.id)
  creation.resolve(third); await creating
  expect(store.getSnapshot().channels).toEqual([first, second, third])
  expect(store.getSnapshot().channelId).toBe(second.id)
})

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers() })
const runFixture = (status: TaskRun['status'] = 'paused'): TaskRun => ({ id: 'run', channelId: first.id, modelConfigId: 'model', status, generation: 1, currentTurnId: null, turnCount: 1, pauseReason: null, createdAt: '', startedAt: '', finishedAt: null, errorMessage: null })
function flow(initialRun?: TaskRun) {
  let snapshot: ChannelTaskSnapshot = { channel: first, schedulerModelConfigId: null, resumeAllowed: initialRun ? { run: true } : {}, agents: [], members: [], messages: [], runs: initialRun ? [initialRun] : [], turns: [], events: [] }
  let emit!: (event: StreamEvent) => void
  const api = {
    projects: { list: vi.fn().mockResolvedValue([{ id: 'p', name: 'project' }]) },
    models: { list: vi.fn().mockResolvedValue(['model', 'selected-model', 'new-model'].map((id) => modelFixture(id))) },
    channels: { list: vi.fn().mockResolvedValue([first, second]) },
    tasks: { snapshot: vi.fn(async (id: string) => id === first.id ? structuredClone(snapshot) : { ...structuredClone(snapshot), channel: second, runs: [], turns: [], messages: [] }), send: vi.fn().mockResolvedValue({ taskRunId: 'created' }), continue: vi.fn(), assign: vi.fn(), cancel: vi.fn(), terminate: vi.fn(), interrupt: vi.fn() },
    consent: { has: vi.fn().mockResolvedValue(true), grant: vi.fn() },
    events: { onStream: vi.fn((listener) => { emit = listener; return () => {} }) },
  } as unknown as AgentTeamApi
  const store = createWorkbenchStore(api); cleanups.push(store.connect())
  return { api, store, emit: (event: StreamEvent) => emit(event), get: () => snapshot, set: (next: ChannelTaskSnapshot) => { snapshot = next } }
}
async function loaded(store: ReturnType<typeof createWorkbenchStore>) { await vi.waitFor(() => expect(store.getSnapshot().conversations[first.id]?.loaded).toBe(true)) }
const modelFixture = (id: string, fallbackConfigId: string | null = null): ModelConfigSummary => ({ id, modelName: id, providerPreset: 'openai', baseUrl: 'https://example.test', hasApiKey: true, fallbackConfigId })

it('sends a roster-only question locally without requesting cloud consent', async () => {
  const context = flow(); await loaded(context.store)
  vi.mocked(context.api.consent.has).mockResolvedValue(false)
  context.store.setDraft('请列出当前群聊 Agent 成员名单')
  await context.store.send()
  expect(context.api.tasks.send).toHaveBeenCalledWith(expect.objectContaining({ content: '请列出当前群聊 Agent 成员名单' }))
  expect(context.api.consent.has).not.toHaveBeenCalled()
  expect(context.store.getSnapshot().consent).toBeNull()
})

it('shows the first bound token synchronously and coalesces a burst into one bounded snapshot read', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  vi.mocked(context.api.tasks.snapshot).mockClear()
  const token = { taskRunId: 'run', type: 'delta' as const, generation: 1, content: '片' }
  context.emit(token)
  expect(context.store.getSnapshot().conversations[first.id].previews[0].content).toBe('片')
  for (let index = 0; index < 99; index++) context.emit(token)
  expect(context.api.tasks.snapshot).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(39)
  expect(context.api.tasks.snapshot).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(1)
  expect(context.store.getSnapshot().conversations[first.id].previews[0].content).toBe('片'.repeat(100))
  expect(vi.getTimerCount()).toBe(1) // Existing polling fallback only.
})

it.each(['complete', 'error'] as const)('flushes %s immediately and removes the scheduled delta refresh', async (type) => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  vi.mocked(context.api.tasks.snapshot).mockClear()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'partial' })
  context.get().runs[0].status = type === 'complete' ? 'completed' : 'failed'
  context.emit({ taskRunId: 'run', type, generation: 1 })
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(40)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(1)
  expect(context.store.getSnapshot().conversations[first.id].previews).toEqual([])
})

it('follows a terminal event with one fresh snapshot when an older snapshot is in flight', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  const old = deferred<ChannelTaskSnapshot>()
  const oldSnapshot = structuredClone(context.get())
  vi.mocked(context.api.tasks.snapshot).mockClear().mockReturnValueOnce(old.promise)
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'partial' })
  await vi.advanceTimersByTimeAsync(40)
  context.get().runs[0].status = 'completed'
  context.emit({ taskRunId: 'run', type: 'complete', generation: 1 })
  old.resolve(oldSnapshot)
  await vi.advanceTimersByTimeAsync(0)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(2)
  expect(context.store.getSnapshot().conversations[first.id].runs[0].status).toBe('completed')
  expect(context.store.getSnapshot().conversations[first.id].previews).toEqual([])
})

it('keeps hidden-channel deltas isolated through navigation and retains the 750 ms polling fallback', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  vi.mocked(context.api.tasks.snapshot).mockClear()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'first channel' })
  await context.store.selectChannel(second.id)
  await vi.advanceTimersByTimeAsync(40)
  expect(context.store.getSnapshot().channelId).toBe(second.id)
  expect(context.store.getSnapshot().conversations[second.id].previews).toEqual([])
  expect(context.store.getSnapshot().conversations[first.id].previews[0].content).toBe('first channel')
  expect(vi.mocked(context.api.tasks.snapshot).mock.calls.map((args) => args[0])).toEqual([second.id, first.id])
  await vi.advanceTimersByTimeAsync(710)
  expect(context.api.tasks.snapshot).toHaveBeenLastCalledWith(second.id)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(3)
})

it('drops stale deltas and cancels a pending refresh on cancellation without replay', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  vi.mocked(context.api.tasks.snapshot).mockClear()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 0, content: 'stale' })
  expect(vi.getTimerCount()).toBe(1)
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'current' })
  vi.mocked(context.api.tasks.cancel).mockImplementation(async () => { context.get().runs[0].generation++; context.get().runs[0].status = 'cancelled' })
  await context.store.cancel()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'late' })
  await vi.advanceTimersByTimeAsync(40)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(1)
  expect(context.store.getSnapshot().conversations[first.id].previews).toEqual([])
  expect(context.api.tasks.send).not.toHaveBeenCalled()
})

it('clears timers and fences retained callbacks and in-flight results on disconnect', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  const old = deferred<ChannelTaskSnapshot>()
  vi.mocked(context.api.tasks.snapshot).mockClear().mockReturnValueOnce(old.promise)
  const pending = context.store.refreshChannel()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'before disconnect' })
  cleanups.pop()!()
  const before = context.store.getSnapshot()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'late' })
  old.resolve(structuredClone(context.get())); await pending
  await vi.advanceTimersByTimeAsync(1000)
  expect(vi.getTimerCount()).toBe(0)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(1)
  expect(context.store.getSnapshot()).toBe(before)
})

it('clears scheduled reads on project changes and channel deletion without resurrecting history', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'old project' })
  vi.mocked(context.api.channels.list).mockResolvedValueOnce([])
  vi.mocked(context.api.tasks.snapshot).mockClear()
  await context.store.selectProject('another')
  await vi.advanceTimersByTimeAsync(40)
  expect(context.api.tasks.snapshot).not.toHaveBeenCalled()
  await context.store.selectProject('p')
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'to delete' })
  context.api.channels.remove = vi.fn().mockResolvedValue(undefined)
  vi.mocked(context.api.channels.list).mockResolvedValueOnce([second])
  vi.mocked(context.api.tasks.snapshot).mockClear()
  await context.store.removeChannel(first.id)
  await vi.advanceTimersByTimeAsync(40)
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(1)
  expect(context.api.tasks.snapshot).toHaveBeenCalledWith(second.id)
  expect(context.store.getSnapshot().conversations[first.id]).toBeUndefined()
})

it('does not resurrect a deleted conversation when its in-flight scheduled snapshot fails', async () => {
  vi.useFakeTimers(); const context = flow(runFixture('running')); await loaded(context.store)
  let reject!: (error: Error) => void
  const failure = new Promise<ChannelTaskSnapshot>((_resolve, fail) => { reject = fail })
  vi.mocked(context.api.tasks.snapshot).mockReturnValueOnce(failure)
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, content: 'to delete' })
  await vi.advanceTimersByTimeAsync(40)
  context.api.channels.remove = vi.fn().mockResolvedValue(undefined)
  vi.mocked(context.api.channels.list).mockResolvedValueOnce([second])
  await context.store.removeChannel(first.id)
  reject(new Error('channel gone'))
  await vi.advanceTimersByTimeAsync(0)
  expect(context.store.getSnapshot().conversations[first.id]).toBeUndefined()
  expect(context.store.getSnapshot().channelId).toBe(second.id)
})

it.each(['send', 'interrupt', 'continue', 'assign'] as const)('uses the selected model for new %s input and the existing Run model for continuation', async (kind) => {
  const { api, store } = flow(kind === 'send' ? undefined : runFixture(kind === 'interrupt' ? 'running' : 'paused'))
  await loaded(store); store.setModel('selected-model'); store.setDraft('new goal')
  if (kind === 'assign') await store.assign('a2')
  else await store[kind]()
  expect(api.consent.has).toHaveBeenCalledWith('p', kind === 'send' || kind === 'interrupt' ? 'selected-model' : 'model')
  if (kind === 'send') expect(api.tasks.send).toHaveBeenCalledWith(expect.objectContaining({ modelConfigId: 'selected-model', content: 'new goal' }))
  else if (kind === 'interrupt') expect(api.tasks.interrupt).toHaveBeenCalledWith('run', expect.objectContaining({ modelConfigId: 'selected-model', content: 'new goal' }))
  else if (kind === 'continue') expect(api.tasks.continue).toHaveBeenCalledWith('run')
  else expect(api.tasks.assign).toHaveBeenCalledWith('run', 'a2')
})

it('invalidates an interrupted action when model selection changes during delayed consent, then authorizes the new model', async () => {
  const { api, store } = flow(runFixture('running')); await loaded(store)
  store.setModel('selected-model'); store.setDraft('replacement goal')
  const consent = deferred<boolean>(); vi.mocked(api.consent.has).mockReturnValueOnce(consent.promise)
  const interrupting = store.interrupt()
  await vi.waitFor(() => expect(api.consent.has).toHaveBeenCalledWith('p', 'selected-model'))
  store.setModel('new-model'); consent.resolve(false); await interrupting
  expect(api.tasks.interrupt).not.toHaveBeenCalled(); expect(store.getSnapshot().consent).toBeNull()
  expect(store.getSnapshot().conversations[first.id].draft).toBe('replacement goal')
  await store.interrupt()
  expect(api.consent.has).toHaveBeenLastCalledWith('p', 'new-model')
  expect(api.tasks.interrupt).toHaveBeenCalledWith('run', expect.objectContaining({ modelConfigId: 'new-model', content: 'replacement goal' }))
})

it('retains a new Turn first delta through an older delayed snapshot, then drains in arrival order once bound', async () => {
  const started = runFixture('running'); started.currentTurnId = 'turn1'
  const context = flow(started); const { api, store } = context
  context.get().turns = [{ id: 'turn1', taskRunId: 'run', ordinal: 1, generation: 1, agentId: 'a1', status: 'running', triggerEventSeq: 1, messageId: null, startedAt: '', finishedAt: null }]
  await loaded(store)
  const old = deferred<ChannelTaskSnapshot>(); const newer = deferred<ChannelTaskSnapshot>()
  const stale = structuredClone(context.get())
  const latest = structuredClone(context.get()); latest.runs[0].currentTurnId = 'turn2'; latest.runs[0].turnCount = 2; latest.turns[0].status = 'completed'
  latest.turns.push({ ...latest.turns[0], id: 'turn2', ordinal: 2, agentId: 'a2', status: 'running' })
  vi.mocked(api.tasks.snapshot).mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise)
  const refresh = store.refreshChannel()
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, turnId: 'turn2', agentId: 'a2', step: 0, content: '第一片' })
  old.resolve(stale)
  await vi.waitFor(() => expect(api.tasks.snapshot).toHaveBeenCalledTimes(3))
  expect(store.getSnapshot().conversations[first.id].previews).toEqual([])
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, turnId: 'turn2', agentId: 'a2', step: 0, content: '第二片' })
  context.set(latest); newer.resolve(latest); await refresh
  expect(store.getSnapshot().conversations[first.id].previews.map((item) => item.content)).toEqual(['第一片第二片'])
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, turnId: 'turn1', agentId: 'a1', content: '旧轮迟到' })
  context.emit({ taskRunId: 'run', type: 'delta', generation: 0, turnId: 'turn2', agentId: 'a2', content: '旧代次迟到' })
  expect(store.getSnapshot().conversations[first.id].previews[0].content).toBe('第一片第二片')
})

it('does not spin refreshes while a future Turn still has no binding', async () => {
  const context = flow(runFixture('running')); await loaded(context.store)
  context.emit({ taskRunId: 'run', type: 'delta', generation: 1, turnId: 'future', agentId: 'a2', content: '等待绑定' })
  await vi.waitFor(() => expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(3))
  await Promise.resolve(); await Promise.resolve()
  expect(context.api.tasks.snapshot).toHaveBeenCalledTimes(3); expect(context.store.getSnapshot().conversations[first.id].previews).toEqual([])
})

it('binds an unknown Run first delta to its durable channel after navigation during the send response', async () => {
  const context = flow(); const { api, store } = context; await loaded(store)
  const sent = deferred<{ taskRunId: string }>(); vi.mocked(api.tasks.send).mockReturnValueOnce(sent.promise)
  store.setDraft('c1 request'); const sending = store.send(); await vi.waitFor(() => expect(api.tasks.send).toHaveBeenCalled())
  await store.selectChannel(second.id)
  // The request is already dispatched in Main, but no Run id has reached Renderer yet.
  context.emit({ taskRunId: 'created', type: 'delta', generation: 1, content: 'c1第一片' })
  await store.refreshChannel(second.id)
  expect(store.getSnapshot().conversations[second.id].previews).toEqual([])
  context.get().runs = [{ ...runFixture('running'), id: 'created' }]
  sent.resolve({ taskRunId: 'created' }); await sending
  expect(store.getSnapshot().conversations[second.id].previews).toEqual([])
  expect(store.getSnapshot().conversations[first.id].previews[0].content).toBe('c1第一片')
  await store.selectChannel(first.id)
  context.emit({ taskRunId: 'created', type: 'delta', generation: 1, content: '第二片' })
  expect(store.getSnapshot().conversations[first.id].previews[0].content).toBe('c1第一片第二片')
  context.get().runs[0].status = 'completed'; await store.refreshChannel(first.id)
  context.emit({ taskRunId: 'created', type: 'delta', generation: 1, content: '完成后迟到' })
  expect(store.getSnapshot().conversations[first.id].previews).toEqual([])
})

it.each([true, false])('invalidates an old draft after c1 to c2 to c1 navigation during delayed consent (%s)', async (granted) => {
  const { api, store } = flow(); await loaded(store)
  const consent = deferred<boolean>(); vi.mocked(api.consent.has).mockReturnValueOnce(consent.promise)
  store.setDraft('old draft'); const sending = store.send(); await vi.waitFor(() => expect(api.consent.has).toHaveBeenCalled())
  await store.selectChannel(second.id); await store.selectChannel(first.id); store.setDraft('new draft')
  consent.resolve(granted); await sending
  expect(api.tasks.send).not.toHaveBeenCalled(); expect(store.getSnapshot().consent).toBeNull(); expect(store.getSnapshot().conversations[first.id].draft).toBe('new draft')
})

it('invalidates delayed resume consent after Run generation changes', async () => {
  const context = flow(runFixture()); const { api, store } = context; await loaded(store)
  const consent = deferred<boolean>(); vi.mocked(api.consent.has).mockReturnValueOnce(consent.promise)
  const continuing = store.continue(); await vi.waitFor(() => expect(api.consent.has).toHaveBeenCalled())
  context.get().runs[0].generation++; await store.refreshChannel(); consent.resolve(true); await continuing
  expect(api.tasks.continue).not.toHaveBeenCalled(); expect(store.getSnapshot().sending).toBe(false)
})

it('a newer explicit assignment supersedes delayed continuation without being cleared by its completion', async () => {
  const { api, store } = flow(runFixture()); await loaded(store)
  const consent = deferred<boolean>(); vi.mocked(api.consent.has).mockReturnValueOnce(consent.promise)
  const continuing = store.continue(); await vi.waitFor(() => expect(api.consent.has).toHaveBeenCalled())
  await store.assign('a2'); expect(api.tasks.assign).toHaveBeenCalledWith('run', 'a2')
  consent.resolve(true); await continuing; expect(api.tasks.continue).not.toHaveBeenCalled()
})

it('cancellation invalidates an assignment still awaiting consent', async () => {
  const context = flow(runFixture()); const { api, store } = context; await loaded(store)
  const consent = deferred<boolean>(); vi.mocked(api.consent.has).mockReturnValueOnce(consent.promise)
  const assigning = store.assign('a2'); await vi.waitFor(() => expect(api.consent.has).toHaveBeenCalled())
  vi.mocked(api.tasks.cancel).mockImplementation(async () => { context.get().runs[0] = { ...context.get().runs[0], status: 'cancelled', generation: 2 }; context.get().resumeAllowed.run = false })
  await store.cancel(); consent.resolve(false); await assigning
  expect(api.tasks.cancel).toHaveBeenCalledWith('run'); expect(api.tasks.assign).not.toHaveBeenCalled(); expect(store.getSnapshot().consent).toBeNull()
})

it.each(['before confirm', 'during grant'])('revalidates Run generation %s and never resumes a stale action', async (phase) => {
  const context = flow(runFixture()); const { api, store } = context; await loaded(store)
  vi.mocked(api.consent.has).mockResolvedValue(false); await store.continue(); expect(store.getSnapshot().consent).not.toBeNull()
  const grant = deferred<void>(); vi.mocked(api.consent.grant).mockReturnValue(grant.promise)
  if (phase === 'before confirm') context.get().runs[0].generation++
  const confirming = store.grantConsent()
  if (phase === 'during grant') { await vi.waitFor(() => expect(api.consent.grant).toHaveBeenCalled()); context.get().runs[0].generation++; await store.refreshChannel() }
  grant.resolve(); await confirming
  if (phase === 'before confirm') expect(api.consent.grant).not.toHaveBeenCalled()
  expect(api.tasks.continue).not.toHaveBeenCalled(); expect(store.getSnapshot().consent).toBeNull(); expect(store.getSnapshot().sending).toBe(false)
})

it('authorizes every fresh fallback candidate separately before dispatching ordinary chat', async () => {
  const { api, store } = flow(); await loaded(store)
  vi.mocked(api.models.list).mockResolvedValue([modelFixture('model', 'backup'), modelFixture('backup', 'last'), modelFixture('last')])
  const granted = new Set<string>()
  vi.mocked(api.consent.has).mockImplementation(async (_project, id) => granted.has(id))
  vi.mocked(api.consent.grant).mockImplementation(async (_project, id) => { granted.add(id) })
  store.setDraft('goal'); await store.send()
  for (const id of ['model', 'backup', 'last']) {
    expect(store.getSnapshot().consent?.modelConfigId).toBe(id)
    if (id !== 'model') expect(store.getSnapshot().consent?.purposes[0]).toContain('备选模型')
    expect(api.tasks.send).not.toHaveBeenCalled()
    await store.grantConsent()
  }
  expect(api.consent.grant).toHaveBeenCalledTimes(3)
  expect(api.tasks.send).toHaveBeenCalledTimes(1)
})

it('expands effective Agent, scheduler and summary fallback routes but not disabled members', async () => {
  const context = flow(); const { api, store } = context; await loaded(store)
  context.get().agents = ['a1', 'a2', 'disabled'].map((id) => ({ id, name: id, avatar: '🤖', title: id, modelConfigId: 'unused', defaultToolPermissions: {}, isBuiltin: false, createdAt: '', updatedAt: '' }))
  context.get().members = ['a1', 'a2', 'disabled'].map((id) => ({ id, channelId: first.id, agentId: id, isEnabled: id !== 'disabled', modelConfigOverrideId: id === 'disabled' ? 'missing' : 'agent', toolPermissionsOverride: null, revision: '1', createdAt: '', updatedAt: '' }))
  context.get().schedulerModelConfigId = 'scheduler'
  vi.mocked(api.models.list).mockResolvedValue([modelFixture('agent', 'backup'), modelFixture('backup'), modelFixture('scheduler', 'backup')])
  store.setDraft('goal'); await store.send()
  expect(vi.mocked(api.consent.has).mock.calls.map((call) => call[1])).toEqual(['agent', 'backup', 'scheduler'])
  expect(api.tasks.send).toHaveBeenCalledTimes(1)
})

it.each([
  [modelFixture('model', 'missing')],
  [modelFixture('model', 'backup'), modelFixture('backup', 'model')],
  [modelFixture('model', 'b1'), modelFixture('b1', 'b2'), modelFixture('b2', 'b3'), modelFixture('b3')],
].map((models) => ({ models })))('rejects malformed fresh routes before checking consent or sending', async ({ models }) => {
  const { api, store } = flow(); await loaded(store)
  vi.mocked(api.models.list).mockResolvedValue(models)
  store.setDraft('goal'); await store.send()
  expect(api.consent.has).not.toHaveBeenCalled(); expect(api.tasks.send).not.toHaveBeenCalled()
  expect(store.getSnapshot().sending).toBe(false)
  expect(store.getSnapshot().conversations[first.id].error).toContain('授权状态读取失败')
})

it('does not grant a displayed consent after the model destination changes', async () => {
  const { api, store } = flow(); await loaded(store)
  vi.mocked(api.consent.has).mockResolvedValue(false)
  store.setDraft('goal'); await store.send()
  vi.mocked(api.models.list).mockResolvedValue([{ ...modelFixture('model'), baseUrl: 'https://changed.test' }])
  await store.grantConsent()
  expect(api.consent.grant).not.toHaveBeenCalled(); expect(api.tasks.send).not.toHaveBeenCalled()
  expect(store.getSnapshot().models[0].baseUrl).toBe('https://changed.test')
  expect(store.getSnapshot().consent?.modelConfigId).toBe('model')
})

it('navigation invalidates a fresh-model read before any consent or dispatch', async () => {
  const { api, store } = flow(); await loaded(store)
  const models = deferred<ModelConfigSummary[]>(); vi.mocked(api.models.list).mockReturnValueOnce(models.promise)
  store.setDraft('goal'); const sending = store.send()
  await vi.waitFor(() => expect(api.models.list).toHaveBeenCalledTimes(2))
  await store.selectChannel(second.id); models.resolve([modelFixture('model')]); await sending
  expect(api.consent.has).not.toHaveBeenCalled(); expect(api.tasks.send).not.toHaveBeenCalled()
})

it('rechecks a route changed during consent before dispatch and requests the new backup consent', async () => {
  const { api, store } = flow(); await loaded(store)
  const consent = deferred<boolean>(); vi.mocked(api.consent.has).mockReturnValueOnce(consent.promise).mockResolvedValue(false)
  store.setDraft('goal'); const sending = store.send()
  await vi.waitFor(() => expect(api.consent.has).toHaveBeenCalled())
  vi.mocked(api.models.list).mockResolvedValue([modelFixture('model', 'backup'), modelFixture('backup')])
  vi.mocked(api.consent.has).mockImplementation(async (_project, id) => id === 'model')
  consent.resolve(true); await sending
  expect(api.tasks.send).not.toHaveBeenCalled()
  expect(store.getSnapshot().consent?.modelConfigId).toBe('backup')
})

it('cancel invalidates a continuation waiting for its fresh model routes', async () => {
  const context = flow(runFixture()); const { api, store } = context; await loaded(store)
  const models = deferred<ModelConfigSummary[]>(); vi.mocked(api.models.list).mockReturnValueOnce(models.promise)
  const continuing = store.continue()
  await vi.waitFor(() => expect(api.models.list).toHaveBeenCalledTimes(2))
  await store.cancel(); models.resolve([modelFixture('model')]); await continuing
  expect(api.tasks.continue).not.toHaveBeenCalled(); expect(api.consent.has).not.toHaveBeenCalled()
  expect(store.getSnapshot().consent).toBeNull()
})

it('ignores a delayed model-list refresh after explicit model selection changes', async () => {
  const { api, store } = flow(); await loaded(store)
  const models = deferred<ModelConfigSummary[]>(); vi.mocked(api.models.list).mockReturnValueOnce(models.promise)
  const refreshing = store.refreshModels(); store.setModel('new-model')
  models.resolve([modelFixture('model')]); await refreshing
  expect(store.getSnapshot().modelId).toBe('new-model')
  expect(store.getSnapshot().models.some((model) => model.id === 'new-model')).toBe(true)
})
