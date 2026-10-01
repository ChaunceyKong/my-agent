import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createSingleAgentRunner } from '../../electron/core/single-agent-runner'
import { createSerialOrchestrator } from '../../electron/core/serial-orchestrator'
import { createSessionSummaryService } from '../../electron/core/session-summary-service'
import { createModelClient, ModelClientError, ModelInterventionError } from '../../electron/core/model-client'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { Agent, StreamEvent } from '../../shared/types'

let directory: string
let database: DatabaseClient
let repositories: Repositories
let taskRuns: ReturnType<typeof createTaskRunService>
let channelId: string
let projectId: string
let primaryId: string
let middleId: string
let backupId: string
let agent: Agent

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'agent-team-fallback-callers-'))
  database = createDatabase({ filePath: join(directory, 'test.sqlite') })
  repositories = createRepositories(database)
  taskRuns = createTaskRunService(repositories)
  const created = await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: directory })
  channelId = created.channel.id; projectId = created.project.id
  const save = (modelName: string, fallbackConfigId?: string) => repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test/v1', modelName,
    encryptedApiKey: 'MAIN_ONLY_KEY', contextWindow: 32768, maxOutputTokens: 1024, fallbackConfigId })
  backupId = (await save('backup')).id
  middleId = (await save('middle', backupId)).id
  primaryId = (await save('primary', middleId)).id
  for (const id of [primaryId, middleId, backupId]) {
    await repositories.recordCloudConsent(projectId, id)
    await repositories.recordToolResultConsent(projectId, id, 1)
  }
  agent = await repositories.createAgent({ name: 'Alpha', title: 'test', avatar: null, systemPrompt: 'Inspect the authorized data', modelConfigId: primaryId, defaultToolPermissions: { read_file: true } })
})
afterEach(() => { vi.useRealTimers(); database.close(); rmSync(directory, { recursive: true, force: true }) })

async function select(onSelected: any, id = backupId) {
  await onSelected({ configuredModelConfigId: primaryId, actualModelConfigId: id, modelSnapshot: JSON.stringify(await repositories.getModelConfig(id)) })
}
async function enableAgent() {
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
}
async function startTurn() {
  await enableAgent()
  const run = await taskRuns.startTaskRun(channelId, primaryId, 'inspect')
  const turn = await repositories.startSingleMemberTurn(run.id, run.generation)
  const active = { agent, modelConfigId: primaryId, memberRevision: (await repositories.listChannelAgents(channelId))[0].revision }
  return { taskRunId: run.id, projectId, channelId, turnId: turn!.id, generation: run.generation, active }
}
function runnerWith(streamChat: any, execute = vi.fn().mockResolvedValue({ execution: { id: 'effect', status: 'completed', resultSummary: 'read complete', policySnapshotJson: '{}' }, result: { path: 'a.md', content: 'safe', truncated: false } })) {
  const modelClient: any = { streamChat }
  return { runner: createSingleAgentRunner({ repositories, taskRuns, modelClient, toolEngine: { execute } as any }), execute }
}
const tool = (taskRunId: string): StreamEvent => ({ taskRunId, type: 'tool_call', toolCall: { index: 0, id: 'call-1', name: 'read_file', arguments: '{"path":"a.md"}' } })

it('binds a fallback tool model and pins it for the observation hop without replay or retries', async () => {
  const input = await startTurn()
  const streamChat = vi.fn(async (request, emit, canSend, onSelected) => {
    await select(onSelected)
    expect(await canSend()).toBe(true)
    if (streamChat.mock.calls.length === 1) await emit(tool(input.taskRunId))
    else {
      expect(request).toMatchObject({ modelConfigId: primaryId, pinnedModelConfigId: backupId, disableRetry: true, hasToolObservations: true })
      await emit({ taskRunId: input.taskRunId, type: 'delta', content: 'finished on backup' })
    }
    await emit({ taskRunId: input.taskRunId, type: 'complete' })
  })
  const { runner, execute } = runnerWith(streamChat)
  const events: StreamEvent[] = []
  const outcome = await runner.run({ ...input, onEvent: async (event) => { events.push(event) } })
  expect(outcome).toEqual({ status: 'completed', content: 'finished on backup' })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(streamChat).toHaveBeenCalledTimes(2)
  const completed = await repositories.completeAgentTurn(input.turnId, 'finished on backup')
  expect(completed.turn).toMatchObject({ configuredModelConfigId: primaryId, actualModelConfigId: backupId })
  expect(completed.message.actualModelConfigId).toBe(backupId)
  expect(JSON.stringify(events)).not.toContain('MAIN_ONLY_KEY')
})

it('stops before uploading a completed tool observation when only the primary has tool consent', async () => {
  const input = await startTurn()
  const streamChat = vi.fn(async (_request, emit, _canSend, onSelected) => {
    await select(onSelected)
    await emit(tool(input.taskRunId)); await emit({ taskRunId: input.taskRunId, type: 'complete' })
  })
  const execute = vi.fn(async () => {
    database.db.run(sql`DELETE FROM tool_result_consents WHERE project_id = ${projectId} AND model_config_id = ${backupId}`)
    return { execution: { id: 'effect', status: 'completed', resultSummary: 'read complete', policySnapshotJson: '{}' } }
  })
  const { runner } = runnerWith(streamChat, execute)
  expect(await runner.run({ ...input, onEvent: async () => {} })).toMatchObject({ status: 'paused', reason: expect.stringContaining('实际模型的工具结果上传授权') })
  expect(execute).toHaveBeenCalledTimes(1)
  expect(streamChat).toHaveBeenCalledTimes(1)
})

it('rejects an intermediate fallback edit before accepting native tool bytes', async () => {
  const input = await startTurn()
  const streamChat = vi.fn(async (_request, emit, canSend, onSelected) => {
    await select(onSelected)
    await repositories.updateModelConfig(middleId, { ...(await repositories.getModelConfig(middleId))!, modelName: 'changed middle' })
    expect(await canSend()).toBe(false)
    await emit(tool(input.taskRunId)); await emit({ taskRunId: input.taskRunId, type: 'complete' })
  })
  const { runner, execute } = runnerWith(streamChat)
  expect(await runner.run({ ...input, onEvent: async () => {} })).toEqual({ status: 'stale' })
  expect(execute).not.toHaveBeenCalled()
})

it('pauses a Turn on a controlled intervention error without executing any effect', async () => {
  const input = await startTurn()
  const { runner, execute } = runnerWith(vi.fn(async (_request, emit) => emit({ taskRunId: input.taskRunId, type: 'error', content: '备选模型不可用，请 CEO 处理', interventionRequired: true })))
  expect(await runner.run({ ...input, onEvent: async () => {} })).toEqual({ status: 'paused', reason: '备选模型不可用，请 CEO 处理' })
  expect(execute).not.toHaveBeenCalled()
})

function directChat(streamChat: any) {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
  const sender = { isDestroyed: () => false, send: vi.fn() }
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showOpenDialog: vi.fn() }, repositories, taskRuns,
    modelClient: { streamChat, requireCloudConsent: vi.fn().mockResolvedValue(undefined) } as any })
  return { sender, send: () => handlers.get(IpcChannel.MessageSend)!({ sender }, { channelId, modelConfigId: primaryId, content: 'hello' }) as Promise<{ taskRunId: string }> }
}

it('keeps the configured direct-chat route while persisting the actual completed model', async () => {
  const direct = directChat(vi.fn(async (request, emit, canSend, onSelected) => {
    await select(onSelected)
    expect(await canSend()).toBe(true)
    await emit({ taskRunId: request.taskRunId, type: 'delta', content: 'backup reply' })
    await emit({ taskRunId: request.taskRunId, type: 'complete' })
  }))
  const { taskRunId } = await direct.send()
  await vi.waitFor(async () => expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'completed', modelConfigId: primaryId }))
  expect((await repositories.listMessages(channelId)).at(-1)).toMatchObject({ content: 'backup reply', actualModelConfigId: backupId })
  expect(JSON.stringify(direct.sender.send.mock.calls)).not.toContain('MAIN_ONLY_KEY')
})

it.each(['before event', 'during commit'])('does not commit direct chat after an intermediate route edit %s', async (phase) => {
  const edit = async () => repositories.updateModelConfig(middleId, { ...(await repositories.getModelConfig(middleId))!, modelName: 'changed middle' })
  if (phase === 'during commit') {
    const transition = repositories.transitionTaskRun.bind(repositories)
    vi.spyOn(repositories, 'transitionTaskRun').mockImplementation(async (id, from, to, metadata, guard) => {
      if (to === 'completed') await edit()
      return transition(id, from, to, metadata, guard)
    })
  }
  const direct = directChat(vi.fn(async (request, emit, _canSend, onSelected) => {
    await select(onSelected)
    if (phase === 'before event') await edit()
    await emit({ taskRunId: request.taskRunId, type: 'complete' })
  }))
  const { taskRunId } = await direct.send()
  await vi.waitFor(async () => expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'failed' }))
  expect(await repositories.listMessages(channelId)).toHaveLength(1)
  expect(direct.sender.send.mock.calls.some(([, event]) => event.type === 'complete')).toBe(false)
})

it.each(['cloud', 'tool-result'])('rejects a guarded Agent commit after actual %s consent revocation', async (scope) => {
  const input = await startTurn()
  const routeSnapshot = JSON.stringify(await repositories.getModelFallbackChain(primaryId))
  await repositories.bindAgentTurnModel({ turnId: input.turnId, configuredModelSnapshot: JSON.stringify(await repositories.getModelConfig(primaryId)),
    actualModelSnapshot: JSON.stringify(await repositories.getModelConfig(backupId)), memberRevision: input.active.memberRevision, modelRouteSnapshot: routeSnapshot })
  if (scope === 'cloud') database.db.run(sql`DELETE FROM cloud_consents WHERE project_id = ${projectId} AND model_config_id = ${backupId}`)
  else database.db.run(sql`DELETE FROM tool_result_consents WHERE project_id = ${projectId} AND model_config_id = ${backupId}`)
  await expect(repositories.completeAgentTurn(input.turnId, 'must not commit', { modelRouteSnapshot: routeSnapshot, hasToolObservations: true })).rejects.toThrow()
  expect((await repositories.listMessages(channelId)).filter((message) => message.origin === 'agent')).toEqual([])
})

it('pauses direct chat on exhausted fallback rather than claiming success', async () => {
  const direct = directChat(vi.fn(async (request, emit) => emit({ taskRunId: request.taskRunId, type: 'error', content: '模型不可用，请 CEO 处理', interventionRequired: true })))
  const { taskRunId } = await direct.send()
  await vi.waitFor(async () => expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ status: 'paused' }))
  expect(await repositories.listMessages(channelId)).toHaveLength(1)
})

it('records the actual fallback scheduler while validating its original routing', async () => {
  await enableAgent()
  const other = await repositories.createAgent({ ...agent, name: 'Beta' })
  await repositories.saveChannelAgent({ channelId, agentId: other.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await repositories.setChannelScheduler(channelId, primaryId)
  const modelClient: any = { selectSpeaker: vi.fn(async (_request, canSend, onSelected) => {
    await select(onSelected); expect(await canSend()).toBe(true)
    return JSON.stringify({ nextSpeaker: null, reason: 'Done on backup' })
  }) }
  const run = await taskRuns.startTaskRun(channelId, primaryId, 'goal')
  await createSerialOrchestrator({ repositories, taskRuns, modelClient, runner: {} as any }).run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'completed' })
  const decision = (await repositories.listTaskRunEvents(run.id)).find((event) => event.eventType === 'speaker_decided')!
  expect(JSON.parse(decision.metadataJson)).toMatchObject({ configuredModelConfigId: primaryId, actualModelConfigId: backupId })
})

it.each([false, true])('saves a fallback summary only while its full route remains current (edit=%s)', async (edit) => {
  await enableAgent(); await repositories.setChannelScheduler(channelId, primaryId)
  const run = await taskRuns.startTaskRun(channelId, primaryId, 'goal')
  for (let index = 0; index < 10; index++) {
    const decision = await repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: agent.id })
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, decision.seq)
    await repositories.completeAgentTurn(turn.id, `turn ${index}`)
  }
  const summarizeSession = vi.fn(async (_request, canSend, onSelected) => {
    await select(onSelected)
    if (edit) await repositories.updateModelConfig(middleId, { ...(await repositories.getModelConfig(middleId))!, modelName: 'changed middle' })
    expect(await canSend()).toBe(!edit)
    return 'backup summary'
  })
  await createSessionSummaryService(repositories, { summarizeSession, requireCloudConsent: vi.fn().mockResolvedValue(undefined) } as any, taskRuns)(run.id)
  const summary = await repositories.getLatestSessionSummary(channelId)
  if (edit) expect(summary).toBeUndefined()
  else expect(summary).toMatchObject({ modelConfigId: backupId, configuredModelConfigId: primaryId, content: 'backup summary' })
})

it.each(['exhausted', 'missing fallback consent'])('pauses a summary for %s and preserves its prior completed prefix', async (failure) => {
  await enableAgent(); await repositories.setChannelScheduler(channelId, primaryId)
  const run = await taskRuns.startTaskRun(channelId, primaryId, 'goal')
  const complete = async () => {
    const decision = await repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: agent.id })
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, decision.seq)
    await repositories.completeAgentTurn(turn.id, 'finished')
  }
  for (let index = 0; index < 10; index++) await complete()
  const error = failure === 'exhausted' ? new ModelClientError('http', 503) : new ModelInterventionError('实际模型未获得外发授权，请 CEO 授权')
  if (error instanceof ModelClientError) error.interventionRequired = true
  const summarizeSession = vi.fn().mockImplementationOnce(async (_request, _canSend, onSelected) => { await select(onSelected); return 'prior summary' }).mockRejectedValueOnce(error)
  const summarize = createSessionSummaryService(repositories, { summarizeSession, requireCloudConsent: vi.fn().mockResolvedValue(undefined) } as any, taskRuns)
  await summarize(run.id)
  const prior = await repositories.getLatestSessionSummary(channelId)
  for (let index = 0; index < 10; index++) await complete()
  await summarize(run.id)
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused' })
  expect(await repositories.getLatestSessionSummary(channelId)).toEqual(prior)
})

it.each(['speaker', 'summary'].flatMap((consumer) => ['401', 'deadline', 'ollama'].map((failure) => ({ consumer, failure }))))('preserves the controlled $failure pause reason from a real $consumer request', async ({ consumer, failure }) => {
  if (failure === 'ollama') await repositories.updateModelConfig(primaryId, { ...(await repositories.getModelConfig(primaryId))!, providerPreset: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', encryptedApiKey: '' })
  await enableAgent(); await repositories.setChannelScheduler(channelId, primaryId)
  if (consumer === 'speaker') {
    const other = await repositories.createAgent({ ...agent, name: 'Beta' })
    await repositories.saveChannelAgent({ channelId, agentId: other.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  }
  const run = await taskRuns.startTaskRun(channelId, primaryId, 'goal')
  if (consumer === 'summary') for (let index = 0; index < 10; index++) {
    const decision = await repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: agent.id })
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, decision.seq)
    await repositories.completeAgentTurn(turn.id, 'completed prefix')
  }
  const fetchImpl = vi.fn(() => {
    if (failure === 'deadline') return new Promise<Response>(() => {})
    if (failure === 'ollama') throw Object.assign(new TypeError('secret transport body'), { cause: { code: 'ECONNREFUSED' } })
    return Promise.resolve(new Response('secret Provider body', { status: 401 }))
  })
  const modelClient = createModelClient({ repositories, taskRuns, consent: createCloudConsentService(repositories), fetch: fetchImpl,
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: () => 'safe-key' } })
  if (failure === 'deadline') vi.useFakeTimers()
  const pending = consumer === 'speaker'
    ? createSerialOrchestrator({ repositories, taskRuns, modelClient, runner: {} as any }).run({ taskRunId: run.id, projectId, channelId, onEvent: async () => {} })
    : createSessionSummaryService(repositories, modelClient, taskRuns)(run.id)
  if (failure === 'deadline') await vi.advanceTimersByTimeAsync(120000)
  await pending
  const reason = failure === '401' ? '模型服务拒绝凭证，请检查 API 密钥配置' : failure === 'ollama' ? '请先启动 Ollama 服务' : '模型调用超过 120 秒，请重试'
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', pauseReason: reason })
  expect(reason).not.toContain('secret')
  expect(fetchImpl).toHaveBeenCalledTimes(failure === 'deadline' ? 4 : 1)
  if (consumer === 'summary') expect(await repositories.getLatestSessionSummary(channelId)).toBeUndefined()
})
