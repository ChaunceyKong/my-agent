import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createSingleAgentRunner } from '../../electron/core/single-agent-runner'
import { createSerialOrchestrator } from '../../electron/core/serial-orchestrator'
import { createApprovalService } from '../../electron/core/approval-service'
import { createProcessToolService } from '../../electron/core/process-tool-service'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createModelClient } from '../../electron/core/model-client'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { Agent, StreamEvent } from '../../shared/types'
import { parseAgentMentions } from '../../electron/core/mention-parser'
import { parseSpeakerDecision, speakerSelectionPrompt } from '../../electron/core/speaker-selector'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'

let directory: string
let database: DatabaseClient
let repositories: Repositories
let channelId: string
let projectId: string
let modelConfigId: string
let first: Agent
let second: Agent
let taskRuns: ReturnType<typeof createTaskRunService>

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'agent-team-serial-'))
  database = createDatabase({ filePath: join(directory, 'test.sqlite') })
  repositories = createRepositories(database)
  taskRuns = createTaskRunService(repositories)
  const created = await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: directory })
  channelId = created.channel.id; projectId = created.project.id
  modelConfigId = (await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'key' })).id
  await repositories.recordCloudConsent(projectId, modelConfigId)
  first = await repositories.createAgent({ name: 'Alpha', avatar: null, title: '', systemPrompt: 'Prompt A', modelConfigId, defaultToolPermissions: { write_file: true } })
  second = await repositories.createAgent({ name: 'Beta', avatar: null, title: '', systemPrompt: 'Prompt B', modelConfigId, defaultToolPermissions: { write_file: true } })
  for (const agent of [first, second]) await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
})
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }) })

const tokens = () => [{ agentId: first.id, start: 0, end: 6, text: '@Alpha' }, { agentId: second.id, start: 7, end: 12, text: '@Beta' }]
it.each(['current_goal', 'latest_agent'])('pauses a scheduler whose configured context cannot fit %s plus output reserve', async (requiredInput) => {
  database.db.run(sql`UPDATE model_configs SET context_window = 2048, max_output_tokens = 512 WHERE id = ${modelConfigId}`)
  await repositories.setChannelScheduler(channelId, modelConfigId)
  await repositories.recordCloudConsent(projectId, modelConfigId)
  const fetch = vi.fn()
  const modelClient = createModelClient({ repositories, consent: createCloudConsentService(repositories), taskRuns,
    crypto: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }, fetch })
  const runner = createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine: createToolEngine(repositories, createApprovalService(repositories)) })
  const orchestrator = createSerialOrchestrator({ repositories, modelClient, taskRuns, runner })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, requiredInput === 'current_goal' ? '文'.repeat(600) : 'goal')
  if (requiredInput === 'latest_agent') {
    const decision = await repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: first.id })
    const turn = await repositories.startAgentTurn(run.id, run.generation, first.id, decision.seq)
    await repositories.completeAgentTurn(turn.id, '文'.repeat(600))
  }
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused' })
  expect(fetch).not.toHaveBeenCalled()
  expect(await repositories.listAgentTurns(run.id)).toHaveLength(requiredInput === 'current_goal' ? 0 : 1)
})

it('retains a complete long CEO goal while bounding only the latest Agent text', async () => {
  const members = await repositories.listChannelAgents(channelId)
  const agents = await repositories.listAgents()
  const goal = 'goal '.repeat(650) + 'mandatory final requirement'
  const data = JSON.parse(speakerSelectionPrompt(members, agents, goal, 'x'.repeat(4000)))
  expect(data.currentCeoGoal).toBe(goal)
  expect(data.latestCompletedAgentMessage).toBe('x'.repeat(3000))
  expect(() => speakerSelectionPrompt(members, agents, '文'.repeat(4000), '')).toThrow('过长')
})
function setup(reply: (system: string, emit: (event: StreamEvent) => Promise<void>) => Promise<void>) {
  const modelClient: any = { requireCloudConsent: vi.fn().mockResolvedValue(undefined), streamChat: vi.fn(async (input: any, emit: any) => reply(input.messages[0].content, emit)) }
  const engine = createToolEngine(repositories, createApprovalService(repositories))
  const runner = createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine: engine })
  const orchestrator = createSerialOrchestrator({ repositories, modelClient, taskRuns, runner })
  return { orchestrator, modelClient }
}

it('persists two enabled members and runs structured CEO mentions in textual order without a generic reply', async () => {
  const { orchestrator, modelClient } = setup(async (system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: system.includes('Prompt A') ? 'A finished' : 'B finished' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha @Beta please collaborate', tokens())
  const events: StreamEvent[] = []
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async (event) => { events.push(event) } })
  expect((await repositories.listChannelAgents(channelId)).filter((member) => member.isEnabled)).toHaveLength(2)
  expect((await repositories.listAgentTurns(run.id)).map((turn) => turn.agentId)).toEqual([first.id, second.id])
  expect((await repositories.listMessages(channelId)).map((message) => [message.agentId, message.content])).toEqual([
    [null, '@Alpha @Beta please collaborate'], [first.id, 'A finished'], [second.id, 'B finished'],
  ])
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 2 })
  expect(modelClient.streamChat).toHaveBeenCalledTimes(2)
  expect(events.at(-1)).toMatchObject({ type: 'error' })
})

it('rejects forged, disabled and overlapping mention tokens without creating a Run', async () => {
  await expect(taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha', [{ agentId: second.id, start: 0, end: 6, text: '@Alpha' }])).rejects.toThrow('Agent 提及无效')
  await repositories.saveChannelAgent({ channelId, agentId: second.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await expect(taskRuns.startTaskRun(channelId, modelConfigId, '@Beta', [{ agentId: second.id, start: 0, end: 5, text: '@Beta' }])).rejects.toThrow('Agent 提及无效')
  await expect(taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha @Alpha', [
    { agentId: first.id, start: 0, end: 6, text: '@Alpha' }, { agentId: first.id, start: 4, end: 10, text: 'ha @Al' },
  ])).rejects.toThrow('Agent 提及无效')
  expect(await repositories.listTaskRuns(channelId)).toEqual([])
})

it('pauses an unassigned multi-member run without guessing the first Agent', async () => {
  const { orchestrator, modelClient } = setup(async (_system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: 'single reply' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const unassigned = await taskRuns.startTaskRun(channelId, modelConfigId, 'who should answer?')
  await orchestrator.run({ taskRunId: unassigned.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(unassigned.id)).toMatchObject({ status: 'paused', turnCount: 0 })
  expect(modelClient.streamChat).not.toHaveBeenCalled()
  await expect(taskRuns.startTaskRun(channelId, modelConfigId, 'new')).rejects.toThrow('继续或结束')
  // The pending paused Run must be explicitly ended before another can start.
  // Task 5 adds the public continuation/termination workflow.
})

it('preserves one-member automatic reply without a CEO mention', async () => {
  await repositories.saveChannelAgent({ channelId, agentId: second.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const { orchestrator, modelClient } = setup(async (_system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: 'single reply' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, 'hello')
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'completed', turnCount: 1 })
  expect((await repositories.listMessages(channelId))[1]).toMatchObject({ agentId: first.id, content: 'single reply' })
  expect(modelClient.streamChat).toHaveBeenCalledTimes(1)
})

it('rejects a stale tool effect when the selected Agent is revoked then re-enabled during its model response', async () => {
  const { orchestrator } = setup(async (_system, emit) => {
    await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
    await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    await emit({ taskRunId: 'ignored', type: 'tool_call', toolCall: { id: 'call-1', index: 0, name: 'write_file', arguments: JSON.stringify({ path: 'new.md', content: 'unsafe' }) } })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha write', [tokens()[0]])
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'failed' })
  expect(await repositories.listToolExecutions(run.id)).toEqual([])
})

it.each(['membership', 'prompt', 'model', 'permissions'] as const)('never sends Channel history after delayed consent changes the selected Agent %s', async (change) => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let consentCalls = 0
  const fetchImpl = vi.fn()
  const modelClient = createModelClient({ repositories, taskRuns, fetch: fetchImpl,
    consent: {
      recordCloudConsent: vi.fn(),
      requireCloudConsent: async () => { if (++consentCalls === 2) { entered(); await gate } },
    },
    crypto: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
  })
  const runner = createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine: createToolEngine(repositories, createApprovalService(repositories)) })
  const orchestrator = createSerialOrchestrator({ repositories, modelClient, taskRuns, runner })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha private history', [tokens()[0]])
  const running = orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  await waiting
  if (change === 'membership') await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  else await repositories.updateAgent(first.id, {
    name: first.name, avatar: first.avatar, title: first.title,
    systemPrompt: change === 'prompt' ? 'Changed prompt' : first.systemPrompt,
    modelConfigId: change === 'model' ? (await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://other.test', modelName: 'other', encryptedApiKey: 'key' })).id : first.modelConfigId,
    defaultToolPermissions: change === 'permissions' ? { write_file: false } : first.defaultToolPermissions,
  })
  release()
  await running
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'failed' })
})

it('does not enter streamChat when the selected Agent is revoked during orchestrator consent', async () => {
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const modelClient: any = { requireCloudConsent: vi.fn(async () => { entered(); await gate }), streamChat: vi.fn() }
  const runner = createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine: createToolEngine(repositories, createApprovalService(repositories)) })
  const orchestrator = createSerialOrchestrator({ repositories, modelClient, taskRuns, runner })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha private history', [tokens()[0]])
  const running = orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  await waiting
  await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  release()
  await running
  expect(modelClient.streamChat).not.toHaveBeenCalled()
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'failed' })
})

it('keeps pending approval as a Turn barrier and never advances to the next speaker after approval', async () => {
  writeFileSync(join(directory, 'draft.md'), 'original')
  const { orchestrator } = setup(async (_system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'tool_call', toolCall: { id: 'call-1', index: 0, name: 'write_file', arguments: JSON.stringify({ path: 'draft.md', content: 'updated' }) } })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha @Beta update', tokens())
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect((await repositories.listAgentTurns(run.id)).map((turn) => turn.status)).toEqual(['waiting_approval'])
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'running', turnCount: 1 })
  const [approval] = await repositories.listApprovalRequests(run.id)
  await createApprovalService(repositories).approve(approval.id, approval.requestHash)
  await createProcessToolService(repositories, taskRuns).runApproved(approval.id)
  expect((await repositories.listAgentTurns(run.id)).map((turn) => turn.status)).toEqual(['waiting_approval'])
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'running', turnCount: 1 })
  expect((await repositories.listTaskRunEvents(run.id)).some((event) => event.eventType === 'tool_decided')).toBe(true)
  await expect(taskRuns.startTaskRun(channelId, modelConfigId, 'another CEO message')).rejects.toThrow('继续或结束')
})

it('lets the database reject competing sends for one Channel', async () => {
  const attempts = await Promise.allSettled([
    taskRuns.startTaskRun(channelId, modelConfigId, 'one'), taskRuns.startTaskRun(channelId, modelConfigId, 'two'),
  ])
  expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1)
})

it('routes IPC structured mentions to the serial orchestrator without selecting the first enabled member', async () => {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  const orchestrator = { run: vi.fn().mockResolvedValue(undefined) }
  const modelClient = { requireCloudConsent: vi.fn().mockResolvedValue(undefined) }
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: vi.fn() }, repositories, taskRuns, modelClient: modelClient as any, orchestrator: orchestrator as any })
  const send = (mentions: unknown) => handlers.get(IpcChannel.MessageSend)!({ sender: { isDestroyed: () => false, send: vi.fn() } },
    { channelId, modelConfigId, content: '@Alpha @Beta collaborate', mentions }) as Promise<{ taskRunId: string }>
  await expect(send([{ agentId: second.id, start: 0, end: 6, text: '@Alpha' }])).rejects.toThrow('Agent 提及无效')
  expect(await repositories.listTaskRuns(channelId)).toEqual([])
  const { taskRunId } = await send(tokens())
  expect(orchestrator.run).toHaveBeenCalledTimes(1)
  expect(orchestrator.run).toHaveBeenCalledWith(expect.objectContaining({ taskRunId, projectId, channelId }))
  expect((await repositories.listTaskRunEvents(taskRunId)).filter((event) => event.eventType === 'mention_queued').map((event) => event.agentId)).toEqual([first.id, second.id])
  expect(modelClient.requireCloudConsent).not.toHaveBeenCalled() // Each Turn checks its own model when it starts.
})

it('persists an unassigned IPC send before safely pausing a multi-member Run', async () => {
  const { orchestrator, modelClient } = setup(async () => {})
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: vi.fn() }, repositories, taskRuns, modelClient, orchestrator })
  const send = vi.fn()
  const { taskRunId } = await handlers.get(IpcChannel.MessageSend)!({ sender: { isDestroyed: () => false, send } },
    { channelId, modelConfigId, content: '请团队讨论，但暂不指定发言人' }) as { taskRunId: string }
  await vi.waitFor(async () => expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'paused', turnCount: 0 }))
  expect((await repositories.listMessages(channelId)).map((message) => message.content)).toEqual(['请团队讨论，但暂不指定发言人'])
  expect(await repositories.listAgentTurns(taskRunId)).toEqual([])
  expect(modelClient.streamChat).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledWith(IpcChannel.MessageStream, expect.objectContaining({ taskRunId, type: 'error' }))
})

it('routes 0-to-1 membership changes during delayed send consent through the Agent orchestrator', async () => {
  await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await repositories.saveChannelAgent({ channelId, agentId: second.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  const orchestrator = { run: vi.fn().mockResolvedValue(undefined) }
  const modelClient = { requireCloudConsent: vi.fn(async () => { entered(); await gate }), streamChat: vi.fn() }
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: vi.fn() }, repositories, taskRuns, modelClient: modelClient as any, orchestrator: orchestrator as any })
  const sending = handlers.get(IpcChannel.MessageSend)!({ sender: { isDestroyed: () => false, send: vi.fn() } },
    { channelId, modelConfigId, content: 'hello' }) as Promise<{ taskRunId: string }>
  await waiting
  await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  release()
  const { taskRunId } = await sending
  expect(orchestrator.run).toHaveBeenCalledWith(expect.objectContaining({ taskRunId }))
  expect(modelClient.streamChat).not.toHaveBeenCalled()
})

it('queues only exact, unique enabled names from a completed Agent message', async () => {
  const duplicate = await repositories.createAgent({ name: 'Beta', avatar: null, title: '', systemPrompt: '', modelConfigId, defaultToolPermissions: {} })
  const members = await repositories.listChannelAgents(channelId)
  expect(parseAgentMentions('@Beta @Alpha @Unknown', first.id, members, await repositories.listAgents())).toEqual([second.id])
  await repositories.saveChannelAgent({ channelId, agentId: duplicate.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  expect(parseAgentMentions('@Beta @Alpha @Unknown', first.id, await repositories.listChannelAgents(channelId), await repositories.listAgents())).toEqual([])
  const { orchestrator } = setup(async (_system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: 'Please ask @Beta and @Unknown; not @Alpha or @BetaX.' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha answer', [tokens()[0]])
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect((await repositories.listTaskRunEvents(run.id)).filter((event) => event.eventType === 'mention_queued')).toHaveLength(1)
  expect((await repositories.listAgentTurns(run.id)).map((turn) => turn.agentId)).toEqual([first.id])
})

it('recognizes punctuation-delimited handoffs without matching email-like or longer names', async () => {
  const members = await repositories.listChannelAgents(channelId)
  const agents = await repositories.listAgents()
  expect(parseAgentMentions('请 @Beta. 然后 @Beta、请检查；不要问 @BetaX 或 mail@Beta。', first.id, members, agents)).toEqual([second.id])
  expect(parseAgentMentions('@BetaX mail@Beta', first.id, members, agents)).toEqual([])
  const duplicate = await repositories.createAgent({ name: 'Beta', avatar: null, title: '', systemPrompt: '', modelConfigId, defaultToolPermissions: {} })
  await repositories.saveChannelAgent({ channelId, agentId: duplicate.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  expect(parseAgentMentions('@Beta. @Beta、请检查', first.id, await repositories.listChannelAgents(channelId), await repositories.listAgents())).toEqual([])
})

it('serially follows a completed Agent handoff without parsing partial messages', async () => {
  const { orchestrator, modelClient } = setup(async (system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: system.includes('Prompt A') ? 'handoff @Beta' : 'done' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha begin', [tokens()[0]])
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect((await repositories.listAgentTurns(run.id)).map((turn) => turn.agentId)).toEqual([first.id, second.id])
  expect(modelClient.streamChat).toHaveBeenCalledTimes(2)
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused' })
})

it('uses a configured scheduler and validates each decision before starting a Turn', async () => {
  await repositories.setChannelScheduler(channelId, modelConfigId)
  await repositories.recordCloudConsent(projectId, modelConfigId)
  const { orchestrator, modelClient } = setup(async (_system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: 'finished' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  modelClient.selectSpeaker = vi.fn().mockResolvedValueOnce(JSON.stringify({ nextSpeaker: first.id, reason: 'Assign Alpha' }))
    .mockResolvedValueOnce(JSON.stringify({ nextSpeaker: null, reason: 'Done' }))
  const goal = 'Please collaborate '.repeat(180) + 'mandatory final requirement'
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, goal)
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect((await repositories.listAgentTurns(run.id)).map((turn) => turn.agentId)).toEqual([first.id])
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'completed' })
  expect(modelClient.selectSpeaker).toHaveBeenCalledTimes(2)
  expect(modelClient.selectSpeaker.mock.calls.map(([input]: [{ prompt: string }]) => JSON.parse(input.prompt))).toEqual([
    expect.objectContaining({ currentCeoGoal: goal, latestCompletedAgentMessage: '' }),
    expect.objectContaining({ currentCeoGoal: goal, latestCompletedAgentMessage: 'finished' }),
  ])
  const decisions = (await repositories.listTaskRunEvents(run.id)).filter((event) => event.eventType === 'speaker_decided')
  expect(decisions.map((event) => event.displayReason)).toEqual(['Assign Alpha', 'Done'])
  expect(decisions.map((event) => JSON.parse(event.metadataJson))).toEqual([
    { reason: 'automatic_selection', configuredModelConfigId: modelConfigId, actualModelConfigId: modelConfigId },
    { reason: 'automatic_complete', configuredModelConfigId: modelConfigId, actualModelConfigId: modelConfigId },
  ])
  database.close()
  database = createDatabase({ filePath: join(directory, 'test.sqlite') })
  repositories = createRepositories(database)
  expect((await repositories.listTaskRunEvents(run.id)).filter((event) => event.eventType === 'speaker_decided').map((event) => event.displayReason)).toEqual(['Assign Alpha', 'Done'])
})

it('rejects unsafe scheduler reason before persisting a decision', async () => {
  await repositories.setChannelScheduler(channelId, modelConfigId)
  const { orchestrator, modelClient } = setup(async () => {})
  modelClient.selectSpeaker = vi.fn().mockResolvedValue(JSON.stringify({ nextSpeaker: first.id, reason: 'hidden\u202Econtrol' }))
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, 'Choose')
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 0 })
  expect((await repositories.listTaskRunEvents(run.id)).filter((event) => event.eventType === 'speaker_decided')).toEqual([])
})

it('normalizes display reason whitespace and rejects oversized reasons', async () => {
  const members = await repositories.listChannelAgents(channelId)
  const agents = await repositories.listAgents()
  expect(parseSpeakerDecision(JSON.stringify({ nextSpeaker: first.id, reason: '  Alpha\n  can inspect\tthis.  ' }), members, agents))
    .toEqual({ nextSpeaker: first.id, reason: 'Alpha can inspect this.' })
  expect(() => parseSpeakerDecision(JSON.stringify({ nextSpeaker: first.id, reason: 'x'.repeat(201) }), members, agents)).toThrow()
})

it.each(['not-json', JSON.stringify({ nextSpeaker: 'unknown', reason: 'bad' }), JSON.stringify({ nextSpeaker: null, reason: '' })])('pauses invalid scheduler output: %s', async (decision) => {
  await repositories.setChannelScheduler(channelId, modelConfigId)
  const { orchestrator, modelClient } = setup(async () => {})
  modelClient.selectSpeaker = vi.fn().mockResolvedValue(decision)
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, 'Choose')
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 0 })
})

it('fences a scheduler decision when membership changes during the model call', async () => {
  await repositories.setChannelScheduler(channelId, modelConfigId)
  const { orchestrator, modelClient } = setup(async () => {})
  modelClient.selectSpeaker = vi.fn(async () => {
    await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
    await repositories.saveChannelAgent({ channelId, agentId: first.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    return JSON.stringify({ nextSpeaker: first.id, reason: 'stale' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, 'Choose')
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 0 })
  expect(await repositories.listAgentTurns(run.id)).toEqual([])
})

it('does not let a null scheduler decision discard pending CEO mentions', async () => {
  await repositories.setChannelScheduler(channelId, modelConfigId)
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha begin', [tokens()[0]])
  const members = await repositories.listChannelAgents(channelId)
  await expect(repositories.commitSpeakerDecision({ taskRunId: run.id, generation: run.generation, modelConfigId,
    memberRevisions: Object.fromEntries(members.map((member) => [member.agentId, member.revision])), nextSpeaker: null, reason: 'Done' })).rejects.toThrow('待处理')
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'running', turnCount: 0 })
})

it('pauses repeated Agent handoff suggestions after three alternating cycles', async () => {
  const { orchestrator, modelClient } = setup(async (system, emit) => {
    await emit({ taskRunId: 'ignored', type: 'delta', content: system.includes('Prompt A') ? '@Beta' : '@Alpha' })
    await emit({ taskRunId: 'ignored', type: 'complete' })
  })
  const run = await taskRuns.startTaskRun(channelId, modelConfigId, '@Alpha begin', [tokens()[0]])
  await orchestrator.run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', turnCount: 12, pauseReason: 'Agent 交替循环达到 3 次，等待 CEO 处理' })
  expect(modelClient.streamChat).toHaveBeenCalledTimes(12)
})

it('exposes only a validated named IPC setting for the Channel scheduler', async () => {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showOpenDialog: vi.fn() }, repositories })
  const setScheduler = handlers.get(IpcChannel.ChannelSetScheduler)!
  await expect(setScheduler(undefined, channelId, 'missing-model')).rejects.toThrow('不存在')
  expect(() => setScheduler(undefined, channelId, { id: modelConfigId })).toThrow('无效')
  await expect(setScheduler(undefined, channelId, modelConfigId)).resolves.toMatchObject({ schedulerModelConfigId: modelConfigId })
  expect(await repositories.getChannel(channelId)).toMatchObject({ schedulerModelConfigId: modelConfigId })
})
