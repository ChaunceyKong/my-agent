import { createHash, randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import type {
  Agent,
  AgentEditorInput,
  AgentTurn,
  AuditEvent,
  ApprovalRequest,
  ApprovalRequestStatus,
  Channel,
  ChannelAgent,
  CeoMentionToken,
  CreateChannelInput,
  CreateProjectInput,
  Message,
  SessionSummary,
  TaskRunEvent,
  TaskRunEventType,
  ModelProviderPreset,
  OverwritePublication,
  OverwritePublicationState,
  Project,
  SaveChannelAgentInput,
  TaskRun,
  ToolExecution,
  ToolName,
  ToolPermissions,
  ToolPolicySnapshot,
  ToolRequest,
  RegisteredExecutable,
} from '../../shared/types'
import { hashToolRequest, toolAuditEvent } from '../core/audit-service'
import { makeTaskRunEvent, type EventMetadata } from '../core/orchestrator-events'
import { parseAgentMentions } from '../core/mention-parser'
import type { AppDatabase, DatabaseClient } from './client'
import { agentTurns, agents, approvalRequests, auditEvents, channelAgents, channels, cloudConsents, toolResultConsents, mentionQueue, messages, modelConfigs, overwritePublications, projects, registeredExecutables, sessionSummaries, taskRunEvents, taskRuns, toolExecutions } from './schema'
import { validateModelBudget } from '../core/context-manager'

export interface ToolContext {
  taskRunId: string
  generation: number
  agentId: string
  turnId?: string
  messageId?: string
}

export type ToolOutcome = Pick<ToolExecution, 'status' | 'riskLevel' | 'resultSummary'>
type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

function appendEvent(tx: Transaction, run: TaskRun, eventType: TaskRunEventType, refs: { agentId?: string; messageId?: string; toolExecutionId?: string; metadata?: EventMetadata; displayReason?: string } = {}): TaskRunEvent {
  const last = tx.select({ seq: taskRunEvents.seq }).from(taskRunEvents)
    .where(eq(taskRunEvents.taskRunId, run.id)).orderBy(sql`${taskRunEvents.seq} DESC`).limit(1).get()
  const event = makeTaskRunEvent({
    taskRunId: run.id, seq: (last?.seq ?? 0) + 1, generation: run.generation, eventType,
    agentId: refs.agentId ?? null, messageId: refs.messageId ?? null, toolExecutionId: refs.toolExecutionId ?? null,
    metadata: refs.metadata, displayReason: refs.displayReason,
  })
  tx.insert(taskRunEvents).values(event).run()
  return event
}

function selectedTurn(tx: Transaction, run: TaskRun, agentId: string, triggerEventSeq: number): AgentTurn {
  if (run.status !== 'running' || run.currentTurnId) throw new Error('任务轮次不可开始')
  const channel = tx.select().from(channels).where(eq(channels.id, run.channelId)).get()
  if (!channel || run.turnCount >= channel.maxTurns) throw new Error('Agent 轮次已达到群聊上限')
  const trigger = tx.select().from(taskRunEvents).where(and(eq(taskRunEvents.taskRunId, run.id), eq(taskRunEvents.seq, triggerEventSeq))).get()
  const member = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.agentId, agentId))).get()
  if (!trigger || trigger.generation !== run.generation || trigger.eventType !== 'speaker_decided'
    || trigger.agentId !== agentId || !member?.isEnabled) throw new Error('Agent 未获得当前发言资格')
  if (tx.select({ id: agentTurns.id }).from(agentTurns)
    .where(and(eq(agentTurns.taskRunId, run.id), eq(agentTurns.triggerEventSeq, triggerEventSeq))).get()) throw new Error('发言决策已被使用')
  if (tx.select().from(toolExecutions).where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.status, ['executing', 'waiting_approval']))).get()) throw new Error('任务仍有未完成操作')
  const timestamp = new Date().toISOString()
  const turn: AgentTurn = { id: randomUUID(), taskRunId: run.id, ordinal: run.turnCount + 1, agentId,
    generation: run.generation, status: 'running', triggerEventSeq, messageId: null, startedAt: timestamp, finishedAt: null }
  tx.insert(agentTurns).values(turn).run()
  tx.update(taskRuns).set({ currentTurnId: turn.id, turnCount: turn.ordinal }).where(eq(taskRuns.id, run.id)).run()
  appendEvent(tx, run, 'turn_started', { agentId, metadata: { ordinal: turn.ordinal } })
  return turn
}

function sortedPermissions(value: ToolPermissions): ToolPermissions {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
}

function permissionTool(toolName: ToolName): ToolName {
  return toolName === 'replace_file_content' ? 'write_file' : toolName
}

function currentPolicy(tx: Transaction, run: TaskRun, agentId: string, toolName: ToolName): string | undefined {
  const agent = tx.select().from(agents).where(eq(agents.id, agentId)).get()
  const member = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.agentId, agentId))).get()
  const channel = tx.select().from(channels).where(eq(channels.id, run.channelId)).get()
  const project = channel && tx.select().from(projects).where(eq(projects.id, channel.projectId)).get()
  const effectiveTool = permissionTool(toolName)
  if (!agent || !member?.isEnabled || !project || agent.defaultToolPermissions[effectiveTool] !== true
    || (member.toolPermissionsOverride !== null && member.toolPermissionsOverride[effectiveTool] !== true)) return undefined
  const snapshot: ToolPolicySnapshot = {
    version: 1, workspacePath: project.workspacePath, agentId, turnId: run.currentTurnId, memberRevision: member.revision,
    defaultToolPermissions: sortedPermissions(agent.defaultToolPermissions),
    toolPermissionsOverride: member.toolPermissionsOverride === null ? null : sortedPermissions(member.toolPermissionsOverride),
    registeredExecutable: null,
  }
  return JSON.stringify(snapshot)
}

function executableIdentity(executable: RegisteredExecutable) {
  return {
    canonicalPath: win32.normalize(executable.absolutePath).toLocaleLowerCase('en-US'),
    isEnabled: executable.isEnabled,
    argumentPolicyHash: createHash('sha256').update(executable.argumentPolicyJson, 'utf8').digest('hex'),
  }
}

function policyForRequest(tx: Transaction, run: TaskRun, agentId: string, request: ToolRequest): string | undefined {
  const base = currentPolicy(tx, run, agentId, request.toolName)
  if (!base || request.toolName !== 'run_process') return base
  const snapshot = JSON.parse(base) as ToolPolicySnapshot
  const executable = tx.select().from(registeredExecutables).where(eq(registeredExecutables.id, request.input.executableId)).get()
  snapshot.registeredExecutable = executable ? executableIdentity(executable) : null
  return JSON.stringify(snapshot)
}

function currentExecutionPolicy(tx: Transaction, run: TaskRun, execution: ToolExecution): string | undefined {
  try {
    return policyForRequest(tx, run, execution.agentId, {
      toolName: execution.toolName,
      input: JSON.parse(execution.inputJson),
    } as ToolRequest)
  } catch { return undefined }
}

function invalidateTools(tx: Transaction, run: TaskRun): void {
  const invalidated = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '任务操作已失效', updatedAt: new Date().toISOString() })
    .where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.status, ['executing', 'waiting_approval']), sql`${toolExecutions.id} NOT IN (SELECT execution_id FROM overwrite_publications WHERE state = 'effect_claimed')`))
    .returning().all()
  for (const execution of invalidated) {
    tx.update(approvalRequests).set({ status: 'cancelled', decidedAt: new Date().toISOString() })
      .where(and(eq(approvalRequests.toolExecutionId, execution.id), inArray(approvalRequests.status, ['pending', 'approved']))).run()
    tx.insert(auditEvents).values(toolAuditEvent(run.channelId, execution)).run()
  }
}

function invalidateChangedToolPolicies(tx: Transaction, scope: SQL): void {
  const pending = tx.select({ execution: toolExecutions, run: taskRuns }).from(toolExecutions)
    .innerJoin(taskRuns, eq(taskRuns.id, toolExecutions.taskRunId))
    .where(and(scope, inArray(toolExecutions.status, ['executing', 'waiting_approval']), sql`${toolExecutions.id} NOT IN (SELECT execution_id FROM overwrite_publications WHERE state = 'effect_claimed')`)).all()
  for (const { execution, run } of pending) {
    if (currentExecutionPolicy(tx, run, execution) === execution.policySnapshotJson) continue
    const cancelled = tx.update(toolExecutions)
      .set({ status: 'cancelled', resultSummary: '任务操作已失效', updatedAt: new Date().toISOString() })
      .where(eq(toolExecutions.id, execution.id)).returning().get()!
    tx.update(approvalRequests).set({ status: 'cancelled', decidedAt: new Date().toISOString() })
      .where(and(eq(approvalRequests.toolExecutionId, execution.id), inArray(approvalRequests.status, ['pending', 'approved']))).run()
    tx.insert(auditEvents).values(toolAuditEvent(run.channelId, cancelled)).run()
  }
}

export interface StartTaskRunInput {
  channelId: string
  modelConfigId: string
  content: string
  mentions?: CeoMentionToken[]
}

export interface SaveModelConfigRecordInput {
  providerPreset: ModelProviderPreset
  baseUrl: string
  modelName: string
  encryptedApiKey: string
  contextWindow?: number | null
  maxOutputTokens?: number | null
}

export interface ModelConfigRecord extends SaveModelConfigRecordInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface Repositories {
  getLatestSessionSummary(channelId: string): Promise<SessionSummary | undefined>
  listSessionSummaryMessages(taskRunId: string, coveredThroughSeq: number, previous?: SessionSummary): Promise<Message[]>
  saveSessionSummary(input: { taskRunId: string; generation: number; coveredThroughSeq: number; content: string; modelConfigId: string; modelSnapshot: string; memberSnapshot: string }): Promise<SessionSummary>
  createToolExecution(context: ToolContext, request: ToolRequest): Promise<ToolExecution>
  getToolExecution(id: string): Promise<ToolExecution | undefined>
  listToolExecutions(taskRunId: string): Promise<ToolExecution[]>
  finishToolExecution(id: string, outcome: () => ToolOutcome): Promise<ToolExecution>
  recordApprovedEffect(executionId: string): Promise<void>
  createApprovalRequest(toolExecutionId: string, expiresAt: string): Promise<ApprovalRequest>
  createOverwriteApproval(toolExecutionId: string, expiresAt: string, targetIdentityJson: string): Promise<ApprovalRequest>
  getApprovalRequest(id: string): Promise<ApprovalRequest | undefined>
  getApprovalForToolExecution(toolExecutionId: string): Promise<ApprovalRequest | undefined>
  listApprovalRequests(taskRunId: string): Promise<ApprovalRequest[]>
  decideApprovalRequest(id: string, requestHash: string, decision: 'approved' | 'rejected', now: string): Promise<ApprovalRequest>
  expireApprovalRequest(id: string, now: string): Promise<ApprovalRequest>
  claimApprovedProcess(id: string, now: string): Promise<{ execution: ToolExecution; executable: RegisteredExecutable; workspacePath: string }>
  claimApprovedOverwrite(id: string, now: string, temporaryRelativePath: string, backupRelativePath: string): Promise<{ execution: ToolExecution; workspacePath: string; publication: OverwritePublication }>
  markOverwriteStaged(executionId: string, temporaryIdentityJson: string): Promise<OverwritePublication>
  markOverwritePublishing(executionId: string): Promise<OverwritePublication>
  claimOverwriteEffect(executionId: string): Promise<OverwritePublication>
  markOverwritePublished(executionId: string): Promise<OverwritePublication>
  completeOverwritePublication(executionId: string): Promise<ToolExecution>
  markOverwriteCleanupPending(executionId: string): Promise<void>
  markOverwriteCleanupComplete(executionId: string): Promise<void>
  recoverOverwritePublication(executionId: string, state: 'recovered' | 'needs_recovery', summary: string): Promise<ToolExecution>
  listRecoverableOverwritePublications(): Promise<Array<{ publication: OverwritePublication; execution: ToolExecution; workspacePath: string }>>
  getRegisteredExecutable(id: string): Promise<RegisteredExecutable | undefined>
  listRegisteredExecutables(): Promise<RegisteredExecutable[]>
  saveRegisteredExecutable(input: Omit<RegisteredExecutable, 'createdAt' | 'updatedAt'>): Promise<RegisteredExecutable>
  advanceTaskRunGeneration(id: string): Promise<TaskRun>
  listAgents(): Promise<Agent[]>
  getAgent(id: string): Promise<Agent | undefined>
  createAgent(input: AgentEditorInput): Promise<Agent>
  updateAgent(id: string, input: AgentEditorInput): Promise<Agent | undefined>
  removeAgent(id: string): Promise<void>
  listChannelAgents(channelId: string): Promise<ChannelAgent[]>
  saveChannelAgent(input: SaveChannelAgentInput): Promise<ChannelAgent>
  removeChannelAgent(channelId: string, agentId: string): Promise<void>
  listProjects(): Promise<Project[]>
  createProjectWithInitialChannel(input: CreateProjectInput): Promise<{ project: Project; channel: Channel }>
  listChannels(projectId: string): Promise<Channel[]>
  getChannel(id: string): Promise<Channel | undefined>
  setChannelScheduler(id: string, modelConfigId: string | null): Promise<Channel>
  createChannel(input: CreateChannelInput): Promise<Channel>
  createStartedTaskRun(input: StartTaskRunInput): Promise<TaskRun>
  getTaskRun(id: string): Promise<TaskRun | undefined>
  listTaskRuns(channelId: string): Promise<TaskRun[]>
  transitionTaskRun(id: string, from: 'running', to: 'completed' | 'failed' | 'cancelled', metadata: Record<string, string>): Promise<TaskRun | undefined>
  recoverRunningTaskRuns(): Promise<number>
  appendTaskRunEvent(id: string, generation: number, eventType: TaskRunEventType, refs?: { agentId?: string; messageId?: string; toolExecutionId?: string; metadata?: EventMetadata }): Promise<TaskRunEvent>
  listTaskRunEvents(id: string): Promise<TaskRunEvent[]>
  startNextMentionTurn(taskRunId: string, generation: number): Promise<AgentTurn | undefined>
  startSingleMemberTurn(taskRunId: string, generation: number): Promise<AgentTurn | undefined>
  commitSpeakerDecision(input: { taskRunId: string; generation: number; modelConfigId: string; memberRevisions: Record<string, string>; nextSpeaker: string | null; reason: string }): Promise<AgentTurn | null>
  markAgentTurnWaiting(id: string, toolExecutionId: string): Promise<AgentTurn>
  pauseTaskRun(id: string, reason: string): Promise<TaskRun>
  startAgentTurn(taskRunId: string, generation: number, agentId: string, triggerEventSeq: number): Promise<AgentTurn>
  completeAgentTurn(id: string, content: string): Promise<{ turn: AgentTurn; message: Message }>
  finishAgentTurn(id: string, status: 'failed' | 'cancelled'): Promise<AgentTurn>
  listAgentTurns(taskRunId: string): Promise<AgentTurn[]>
  listMessages(channelId: string): Promise<Message[]>
  listAuditEvents(channelId: string): Promise<AuditEvent[]>
  saveModelConfig(input: SaveModelConfigRecordInput): Promise<ModelConfigRecord>
  listModelConfigs(): Promise<ModelConfigRecord[]>
  getModelConfig(id: string): Promise<ModelConfigRecord | undefined>
  recordCloudConsent(projectId: string, modelConfigId: string): Promise<void>
  hasCloudConsent(projectId: string, modelConfigId: string): Promise<boolean>
  recordToolResultConsent(projectId: string, modelConfigId: string, scopeVersion: number): Promise<void>
  hasToolResultConsent(projectId: string, modelConfigId: string, scopeVersion: number): Promise<boolean>
}

export function createRepositories(client: DatabaseClient): Repositories {
  return {
    async getLatestSessionSummary(channelId) {
      return client.db.select().from(sessionSummaries).where(eq(sessionSummaries.channelId, channelId)).orderBy(sql`rowid DESC`).limit(1).get()
    },
    async listSessionSummaryMessages(taskRunId, coveredThroughSeq, previous) {
      // A summary covers the Channel prefix ordered by durable Run rowid, then event seq.
      // This includes the unsummarized tail of every older Run, not just the current Run.
      return client.db.select().from(messages).where(and(
        sql`${messages.channelId} = (SELECT channel_id FROM task_runs WHERE id = ${taskRunId})`,
        sql`${messages.taskRunSeq} IS NOT NULL`,
        or(eq(messages.status, 'completed'), and(eq(messages.origin, 'ceo'), eq(messages.status, 'sent'))),
        sql`((SELECT rowid FROM task_runs WHERE id = ${messages.taskRunId}) < (SELECT rowid FROM task_runs WHERE id = ${taskRunId}) OR (${messages.taskRunId} = ${taskRunId} AND ${messages.taskRunSeq} <= ${coveredThroughSeq}))`,
        previous ? sql`((SELECT rowid FROM task_runs WHERE id = ${messages.taskRunId}) > (SELECT rowid FROM task_runs WHERE id = ${previous.taskRunId}) OR (${messages.taskRunId} = ${previous.taskRunId} AND ${messages.taskRunSeq} > ${previous.coveredThroughSeq}))` : undefined,
      )).orderBy(sql`(SELECT rowid FROM task_runs WHERE id = ${messages.taskRunId})`, asc(messages.taskRunSeq), asc(messages.id)).all()
    },
    async saveSessionSummary(input) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).get()
        const channel = run && tx.select().from(channels).where(eq(channels.id, run.channelId)).get()
        const config = tx.select().from(modelConfigs).where(eq(modelConfigs.id, input.modelConfigId)).get()
        const members = run && tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.isEnabled, true))).all()
        const identities = members?.map((member) => ({ member, agent: tx.select().from(agents).where(eq(agents.id, member.agentId)).get() })).sort((a, b) => a.member.agentId.localeCompare(b.member.agentId))
        if (!run || run.status !== 'running' || run.generation !== input.generation || run.currentTurnId || channel?.schedulerModelConfigId !== input.modelConfigId
          || JSON.stringify(config) !== input.modelSnapshot || JSON.stringify(identities) !== input.memberSnapshot
          || !tx.select().from(cloudConsents).where(and(eq(cloudConsents.projectId, channel.projectId), eq(cloudConsents.modelConfigId, input.modelConfigId))).get()) throw new Error('摘要状态已失效')
        const cutoff = tx.select().from(taskRunEvents).where(and(eq(taskRunEvents.taskRunId, run.id), eq(taskRunEvents.seq, input.coveredThroughSeq), eq(taskRunEvents.eventType, 'turn_completed'))).get()
        if (!cutoff || !Number.isSafeInteger(input.coveredThroughSeq) || !input.content.trim() || Buffer.byteLength(input.content, 'utf8') > 8000) throw new Error('摘要内容无效')
        const prior = tx.select().from(sessionSummaries).where(eq(sessionSummaries.taskRunId, run.id)).orderBy(sql`${sessionSummaries.coveredThroughSeq} DESC`).limit(1).get()
        if (prior && prior.coveredThroughSeq >= input.coveredThroughSeq) return prior
        const saved = tx.insert(sessionSummaries).values({ id: randomUUID(), channelId: run.channelId, taskRunId: run.id,
          coveredThroughSeq: input.coveredThroughSeq, content: input.content, modelConfigId: input.modelConfigId, createdAt: new Date().toISOString() }).returning().get()!
        appendEvent(tx, run, 'summary_created')
        return saved
      })
    },
    async createToolExecution(context, request) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, context.taskRunId)).get()
        if (!run || run.status !== 'running' || run.generation !== context.generation) throw new Error('任务操作已失效')
        if (context.turnId && (run.currentTurnId !== context.turnId || !tx.select().from(agentTurns)
          .where(and(eq(agentTurns.id, context.turnId), eq(agentTurns.agentId, context.agentId), eq(agentTurns.status, 'running'))).get())) throw new Error('任务轮次已失效')
        const policySnapshotJson = policyForRequest(tx, run, context.agentId, request)
        if (!policySnapshotJson) throw new Error('工具未授权')
        if (context.messageId) {
          const message = tx.select().from(messages).where(eq(messages.id, context.messageId)).get()
          if (message?.taskRunId !== run.id || message.channelId !== run.channelId) throw new Error('工具消息不属于当前任务')
        }
        if (tx.select().from(toolExecutions).where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.status, ['executing', 'waiting_approval']))).get()) {
          throw new Error('任务已有未完成的工具操作')
        }
        const timestamp = new Date().toISOString()
        const execution: ToolExecution = {
          id: randomUUID(), taskRunId: run.id, generation: run.generation, agentId: context.agentId,
          messageId: context.messageId ?? null, toolName: request.toolName, inputJson: JSON.stringify(request.input),
          policySnapshotJson,
          requestHash: hashToolRequest({ taskRunId: run.id, generation: run.generation, agentId: context.agentId, messageId: context.messageId ?? null, request, policySnapshotJson }),
          overwriteTargetIdentityJson: null,
          riskLevel: request.toolName === 'write_file' || request.toolName === 'replace_file_content' ? 'medium' : 'low', status: 'executing',
          resultSummary: null, createdAt: timestamp, updatedAt: timestamp,
        }
        tx.insert(toolExecutions).values(execution).run()
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, execution)).run()
        return execution
      })
    },

    async getToolExecution(id) {
      return client.db.select().from(toolExecutions).where(eq(toolExecutions.id, id)).get()
    },

    async listToolExecutions(taskRunId) {
      return client.db.select().from(toolExecutions).where(eq(toolExecutions.taskRunId, taskRunId))
        .orderBy(asc(toolExecutions.createdAt), asc(toolExecutions.id)).all()
    },

    async finishToolExecution(id, outcome) {
      // The final local side effect is synchronous: cancellation cannot interleave between
      // the persisted generation/policy check and publication on Main's event loop.
      return client.db.transaction((tx) => {
        const current = tx.select().from(toolExecutions).where(eq(toolExecutions.id, id)).get()
        if (!current) throw new Error('工具操作不存在')
        if (current.status !== 'executing') return current
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, current.taskRunId)).get()!
        const valid = run.status === 'running' && run.generation === current.generation
          && currentExecutionPolicy(tx, run, current) === current.policySnapshotJson
        const result: ToolOutcome = valid ? outcome() : { status: 'cancelled', riskLevel: current.riskLevel, resultSummary: '任务操作已失效' }
        const next = tx.update(toolExecutions).set({ ...result, updatedAt: new Date().toISOString() })
          .where(eq(toolExecutions.id, id)).returning().get()!
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, next)).run()
        return next
      })
    },

    async recordApprovedEffect(executionId) {
      client.db.transaction((tx) => {
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, executionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!execution || !run || run.status !== 'running' || run.generation !== execution.generation
          || !['completed', 'failed'].includes(execution.status)) return
        if (tx.select().from(taskRunEvents).where(and(eq(taskRunEvents.taskRunId, run.id), eq(taskRunEvents.toolExecutionId, execution.id), eq(taskRunEvents.eventType, 'tool_decided'))).get()) return
        appendEvent(tx, run, 'tool_decided', { agentId: execution.agentId, toolExecutionId: execution.id })
      })
    },

    async createApprovalRequest(toolExecutionId, expiresAt) {
      return client.db.transaction((tx) => {
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, toolExecutionId)).get()
        if (!execution || execution.status !== 'executing') throw new Error('审批对象不可用')
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!run || run.status !== 'running' || run.generation !== execution.generation
          || currentExecutionPolicy(tx, run, execution) !== execution.policySnapshotJson) throw new Error('审批对象已失效')
        const timestamp = new Date().toISOString()
        const approval: ApprovalRequest = { id: randomUUID(), toolExecutionId, requestHash: execution.requestHash,
          generation: execution.generation, policySnapshotJson: execution.policySnapshotJson, status: 'pending', expiresAt, decidedAt: null, createdAt: timestamp }
        tx.insert(approvalRequests).values(approval).run()
        const waiting = tx.update(toolExecutions).set({ status: 'waiting_approval', riskLevel: 'high', resultSummary: '等待 CEO 审批', updatedAt: timestamp })
          .where(and(eq(toolExecutions.id, execution.id), eq(toolExecutions.status, 'executing'))).returning().get()
        if (!waiting) throw new Error('审批对象已失效')
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, waiting)).run()
        return approval
      })
    },

    async createOverwriteApproval(toolExecutionId, expiresAt, targetIdentityJson) {
      return client.db.transaction((tx) => {
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, toolExecutionId)).get()
        if (!execution || execution.status !== 'executing' || !['write_file', 'replace_file_content'].includes(execution.toolName)) throw new Error('审批对象不可用')
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!run || run.status !== 'running' || run.generation !== execution.generation
          || currentExecutionPolicy(tx, run, execution) !== execution.policySnapshotJson) throw new Error('审批对象已失效')
        const timestamp = new Date().toISOString()
        const approval: ApprovalRequest = { id: randomUUID(), toolExecutionId, requestHash: execution.requestHash,
          generation: execution.generation, policySnapshotJson: execution.policySnapshotJson, status: 'pending', expiresAt, decidedAt: null, createdAt: timestamp }
        tx.insert(approvalRequests).values(approval).run()
        const waiting = tx.update(toolExecutions).set({ overwriteTargetIdentityJson: targetIdentityJson, status: 'waiting_approval', riskLevel: 'high', resultSummary: '目标已存在，覆盖需要 CEO 审批', updatedAt: timestamp })
          .where(and(eq(toolExecutions.id, execution.id), eq(toolExecutions.status, 'executing'))).returning().get()
        if (!waiting) throw new Error('审批对象已失效')
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, waiting)).run()
        return approval
      })
    },

    async getApprovalRequest(id) {
      return client.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
    },

    async getApprovalForToolExecution(toolExecutionId) {
      return client.db.select().from(approvalRequests).where(eq(approvalRequests.toolExecutionId, toolExecutionId)).get()
    },

    async listApprovalRequests(taskRunId) {
      return client.db.select({ approval: approvalRequests }).from(approvalRequests)
        .innerJoin(toolExecutions, eq(toolExecutions.id, approvalRequests.toolExecutionId))
        .where(eq(toolExecutions.taskRunId, taskRunId)).orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id)).all()
        .map(({ approval }) => approval)
    },

    async decideApprovalRequest(id, requestHash, decision, now) {
      return client.db.transaction((tx) => {
        const approval = tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
        if (!approval || approval.status !== 'pending' || approval.requestHash !== requestHash) throw new Error('审批请求不可用')
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, approval.toolExecutionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        const valid = execution?.status === 'waiting_approval' && run?.status === 'running' && run.generation === approval.generation
          && execution.generation === approval.generation && execution.requestHash === approval.requestHash
          && execution.policySnapshotJson === approval.policySnapshotJson
          && currentExecutionPolicy(tx, run, execution) === approval.policySnapshotJson
        const status: ApprovalRequestStatus = new Date(approval.expiresAt).getTime() <= new Date(now).getTime() ? 'expired' : valid ? decision : 'cancelled'
        const next = tx.update(approvalRequests).set({ status, decidedAt: now }).where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'pending'))).returning().get()
        if (!next) throw new Error('审批请求不可用')
        if (status === 'approved' && execution) {
          const claimed = tx.update(toolExecutions).set({ status: 'executing', updatedAt: now })
            .where(and(eq(toolExecutions.id, execution.id), eq(toolExecutions.status, 'waiting_approval'))).returning().get()
          if (!claimed || !run) throw new Error('审批对象已失效')
          tx.insert(auditEvents).values(toolAuditEvent(run.channelId, claimed)).run()
        }
        if (status !== 'approved' && execution && run) {
          const cancelled = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '审批未通过或已失效', updatedAt: now })
            .where(and(eq(toolExecutions.id, execution.id), eq(toolExecutions.status, 'waiting_approval'))).returning().get()
          if (cancelled) {
            tx.insert(auditEvents).values(toolAuditEvent(run.channelId, cancelled)).run()
            if (run.status === 'running' && run.generation === execution.generation) appendEvent(tx, run, 'tool_decided', { agentId: execution.agentId, toolExecutionId: execution.id })
          }
        }
        return next
      })
    },

    async claimApprovedProcess(id, now) {
      const claimed = client.db.transaction((tx) => {
        const approval = tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
        const execution = approval && tx.select().from(toolExecutions).where(eq(toolExecutions.id, approval.toolExecutionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        const expire = () => {
          if (approval?.status === 'approved') tx.update(approvalRequests).set({ status: 'expired', decidedAt: now }).where(eq(approvalRequests.id, id)).run()
          if (execution && run && execution.status === 'executing') {
            const cancelled = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '审批已过期', updatedAt: now })
              .where(eq(toolExecutions.id, execution.id)).returning().get()
            if (cancelled) tx.insert(auditEvents).values(toolAuditEvent(run.channelId, cancelled)).run()
          }
          return undefined
        }
        const invalidate = () => {
          if (approval?.status === 'approved') tx.update(approvalRequests).set({ status: 'cancelled', decidedAt: now }).where(eq(approvalRequests.id, id)).run()
          if (execution && run && execution.status === 'executing') {
            const cancelled = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '审批目标已失效', updatedAt: now })
              .where(eq(toolExecutions.id, execution.id)).returning().get()
            if (cancelled) tx.insert(auditEvents).values(toolAuditEvent(run.channelId, cancelled)).run()
          }
        }
        if (!approval || !execution || !run || approval.status !== 'approved' || execution.status !== 'executing'
          || execution.toolName !== 'run_process' || execution.requestHash !== approval.requestHash
          || execution.generation !== approval.generation || execution.policySnapshotJson !== approval.policySnapshotJson) throw new Error('审批请求不可用')
        if (new Date(approval.expiresAt).getTime() <= new Date(now).getTime()) return expire()
        if (run.status !== 'running' || run.generation !== approval.generation
          || currentExecutionPolicy(tx, run, execution) !== approval.policySnapshotJson) {
          invalidate(); throw new Error('审批请求不可用')
        }
        let input: { executableId?: unknown; args?: unknown }
        let snapshot: { workspacePath?: unknown }
        try { input = JSON.parse(execution.inputJson); snapshot = JSON.parse(execution.policySnapshotJson) } catch { invalidate(); throw new Error('审批请求不可用') }
        if (typeof input.executableId !== 'string' || !Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string')
          || typeof snapshot.workspacePath !== 'string') { invalidate(); throw new Error('审批请求不可用') }
        const executable = tx.select().from(registeredExecutables).where(eq(registeredExecutables.id, input.executableId)).get()
        if (!executable?.isEnabled) { invalidate(); throw new Error('登记可执行文件不可用') }
        const claimed = tx.update(approvalRequests).set({ status: 'executing', decidedAt: now })
          .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'approved'))).returning().get()
        if (!claimed) throw new Error('审批请求不可用')
        return { execution, executable, workspacePath: snapshot.workspacePath }
      })
      if (!claimed) throw new Error('审批请求已过期')
      return claimed
    },

    async claimApprovedOverwrite(id, now, temporaryRelativePath, backupRelativePath) {
      const claimed = client.db.transaction((tx) => {
        const approval = tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
        const execution = approval && tx.select().from(toolExecutions).where(eq(toolExecutions.id, approval.toolExecutionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        const expire = () => {
          if (approval?.status === 'approved') tx.update(approvalRequests).set({ status: 'expired', decidedAt: now }).where(eq(approvalRequests.id, id)).run()
          if (execution && run && execution.status === 'executing') {
            const cancelled = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '审批已过期', updatedAt: now }).where(eq(toolExecutions.id, execution.id)).returning().get()
            if (cancelled) tx.insert(auditEvents).values(toolAuditEvent(run.channelId, cancelled)).run()
          }
          return undefined
        }
        if (!approval || !execution || !run || approval.status !== 'approved' || execution.status !== 'executing'
          || !['write_file', 'replace_file_content'].includes(execution.toolName) || !execution.overwriteTargetIdentityJson || execution.requestHash !== approval.requestHash
          || execution.generation !== approval.generation || execution.policySnapshotJson !== approval.policySnapshotJson) throw new Error('审批请求不可用')
        if (new Date(approval.expiresAt).getTime() <= new Date(now).getTime()) return expire()
        if (run.status !== 'running' || run.generation !== approval.generation
          || currentExecutionPolicy(tx, run, execution) !== approval.policySnapshotJson) throw new Error('审批请求不可用')
        let input: { path?: unknown; content?: unknown }
        let snapshot: { workspacePath?: unknown }
        try { input = JSON.parse(execution.inputJson); snapshot = JSON.parse(execution.policySnapshotJson) } catch { throw new Error('审批请求不可用') }
        if (typeof input.path !== 'string' || typeof input.content !== 'string' || typeof snapshot.workspacePath !== 'string') throw new Error('审批请求不可用')
        if (!/^\.agent-team-[0-9a-f-]{36}\.tmp$/.test(temporaryRelativePath)
          || !/^\.agent-team-[0-9a-f-]{36}\.backup$/.test(backupRelativePath)) throw new Error('审批请求不可用')
        const claimed = tx.update(approvalRequests).set({ status: 'executing', decidedAt: now })
          .where(and(eq(approvalRequests.id, id), eq(approvalRequests.status, 'approved'))).returning().get()
        if (!claimed) throw new Error('审批请求不可用')
        const publication: OverwritePublication = { executionId: execution.id, temporaryRelativePath, backupRelativePath,
          temporaryIdentityJson: null, state: 'preparing', createdAt: now, updatedAt: now }
        tx.insert(overwritePublications).values(publication).run()
        return { execution, workspacePath: snapshot.workspacePath, publication }
      })
      if (!claimed) throw new Error('审批请求已过期')
      return claimed
    },

    async markOverwriteStaged(executionId, temporaryIdentityJson) {
      const timestamp = new Date().toISOString()
      const next = client.db.update(overwritePublications).set({ state: 'staged', temporaryIdentityJson, updatedAt: timestamp })
        .where(and(eq(overwritePublications.executionId, executionId), eq(overwritePublications.state, 'preparing'))).returning().get()
      if (!next) throw new Error('覆盖发布状态不可用')
      return next
    },

    async markOverwritePublishing(executionId) {
      return client.db.transaction((tx) => {
        const publication = tx.select().from(overwritePublications).where(eq(overwritePublications.executionId, executionId)).get()
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, executionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!publication || publication.state !== 'staged' || !execution || !run || execution.status !== 'executing'
          || run.status !== 'running' || run.generation !== execution.generation
          || currentExecutionPolicy(tx, run, execution) !== execution.policySnapshotJson) throw new Error('任务操作已失效')
        const next = tx.update(overwritePublications).set({ state: 'publishing', updatedAt: new Date().toISOString() })
          .where(and(eq(overwritePublications.executionId, executionId), eq(overwritePublications.state, 'staged'))).returning().get()
        if (!next) throw new Error('覆盖发布状态不可用')
        return next
      })
    },

    async claimOverwriteEffect(executionId) {
      return client.db.transaction((tx) => {
        const publication = tx.select().from(overwritePublications).where(eq(overwritePublications.executionId, executionId)).get()
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, executionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!publication || publication.state !== 'publishing' || !execution || !run || execution.status !== 'executing' || run.status !== 'running' || run.generation !== execution.generation || currentExecutionPolicy(tx, run, execution) !== execution.policySnapshotJson) throw new Error('任务操作已失效')
        const next = tx.update(overwritePublications).set({ state: 'effect_claimed', updatedAt: new Date().toISOString() }).where(and(eq(overwritePublications.executionId, executionId), eq(overwritePublications.state, 'publishing'))).returning().get()
        if (!next) throw new Error('覆盖发布状态不可用')
        return next
      })
    },

    async markOverwritePublished(executionId) {
      const next = client.db.update(overwritePublications).set({ state: 'published', updatedAt: new Date().toISOString() })
        .where(and(eq(overwritePublications.executionId, executionId), eq(overwritePublications.state, 'effect_claimed'))).returning().get()
      if (!next) throw new Error('覆盖发布状态不可用')
      return next
    },

    async completeOverwritePublication(executionId) {
      return client.db.transaction((tx) => {
        const publication = tx.select().from(overwritePublications).where(eq(overwritePublications.executionId, executionId)).get()
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, executionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!publication || !execution || !run || !['published', 'effect_claimed'].includes(publication.state) || execution.status !== 'executing') throw new Error('覆盖发布状态不可用')
        const completed = tx.update(toolExecutions).set({ status: 'completed', riskLevel: 'high', resultSummary: '已按批准覆盖文件', updatedAt: new Date().toISOString() })
          .where(eq(toolExecutions.id, executionId)).returning().get()!
        tx.update(overwritePublications).set({ state: 'completed', updatedAt: new Date().toISOString() }).where(eq(overwritePublications.executionId, executionId)).run()
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, completed)).run()
        return completed
      })
    },

    async markOverwriteCleanupPending(executionId) {
      const execution = await client.db.select().from(toolExecutions).where(eq(toolExecutions.id, executionId)).get()
      const run = execution && await client.db.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
      if (!execution || !run) throw new Error('覆盖发布状态不可用')
      // Persist recovery discoverability before best-effort audit. An audit failure must
      // never strand hidden artifacts behind an apparently completed journal.
      await client.db.update(overwritePublications).set({ state: 'cleanup_pending', updatedAt: new Date().toISOString() }).where(eq(overwritePublications.executionId, executionId)).run()
      try { await client.db.insert(auditEvents).values({ id: randomUUID(), channelId: run.channelId, taskRunId: run.id, eventType: 'overwrite_cleanup_pending', metadataJson: JSON.stringify({ toolExecutionId: executionId }), createdAt: new Date().toISOString() }).run() } catch { /* Recovery state is authoritative. */ }
    },

    async markOverwriteCleanupComplete(executionId) {
      client.db.update(overwritePublications).set({ state: 'completed', updatedAt: new Date().toISOString() }).where(and(eq(overwritePublications.executionId, executionId), eq(overwritePublications.state, 'cleanup_pending'))).run()
    },

    async recoverOverwritePublication(executionId, state, summary) {
      return client.db.transaction((tx) => {
        const publication = tx.select().from(overwritePublications).where(eq(overwritePublications.executionId, executionId)).get()
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, executionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        if (!publication || !execution || !run) throw new Error('覆盖发布状态不可用')
        const next = tx.update(toolExecutions).set({ status: 'failed', riskLevel: 'high', resultSummary: summary, updatedAt: new Date().toISOString() })
          .where(eq(toolExecutions.id, executionId)).returning().get()!
        tx.update(overwritePublications).set({ state, updatedAt: new Date().toISOString() }).where(eq(overwritePublications.executionId, executionId)).run()
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, next)).run()
        return next
      })
    },

    async listRecoverableOverwritePublications() {
      return client.db.select({ publication: overwritePublications, execution: toolExecutions, workspacePath: projects.workspacePath }).from(overwritePublications)
        .innerJoin(toolExecutions, eq(toolExecutions.id, overwritePublications.executionId))
        .innerJoin(taskRuns, eq(taskRuns.id, toolExecutions.taskRunId))
        .innerJoin(channels, eq(channels.id, taskRuns.channelId))
        .innerJoin(projects, eq(projects.id, channels.projectId))
        .where(inArray(overwritePublications.state, ['preparing', 'staged', 'publishing', 'effect_claimed', 'published', 'cleanup_pending'])).all()
    },

    async expireApprovalRequest(id, now) {
      return client.db.transaction((tx) => {
        const approval = tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).get()
        if (!approval || !['pending', 'approved'].includes(approval.status)) throw new Error('审批请求不可用')
        const execution = tx.select().from(toolExecutions).where(eq(toolExecutions.id, approval.toolExecutionId)).get()
        const run = execution && tx.select().from(taskRuns).where(eq(taskRuns.id, execution.taskRunId)).get()
        const next = tx.update(approvalRequests).set({ status: 'expired', decidedAt: now })
          .where(eq(approvalRequests.id, id)).returning().get()!
        if (execution && run && ['executing', 'waiting_approval'].includes(execution.status)) {
          const cancelled = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '审批已过期', updatedAt: now })
            .where(eq(toolExecutions.id, execution.id)).returning().get()!
          tx.insert(auditEvents).values(toolAuditEvent(run.channelId, cancelled)).run()
        }
        return next
      })
    },

    async getRegisteredExecutable(id) {
      return client.db.select().from(registeredExecutables).where(eq(registeredExecutables.id, id)).get()
    },

    async listRegisteredExecutables() {
      return client.db.select().from(registeredExecutables).orderBy(asc(registeredExecutables.id)).all()
    },

    async saveRegisteredExecutable(input) {
      const timestamp = new Date().toISOString()
      return client.db.transaction((tx) => {
        const saved = tx.insert(registeredExecutables).values({ ...input, createdAt: timestamp, updatedAt: timestamp })
          .onConflictDoUpdate({ target: registeredExecutables.id, set: { ...input, updatedAt: timestamp } }).returning().get()
        // A registration id is not a capability. Editing it changes the immutable
        // approval target, so pending or merely approved process requests fail closed.
        invalidateChangedToolPolicies(tx, eq(toolExecutions.toolName, 'run_process'))
        return saved
      })
    },

    async advanceTaskRunGeneration(id) {
      return client.db.transaction((tx) => {
        const current = tx.select().from(taskRuns).where(eq(taskRuns.id, id)).get()
        if (current?.status !== 'running') throw new Error('任务操作已失效')
        const next = tx.update(taskRuns).set({ generation: current.generation + 1, currentTurnId: null }).where(eq(taskRuns.id, id)).returning().get()!
        tx.update(agentTurns).set({ status: 'cancelled', finishedAt: new Date().toISOString() })
          .where(and(eq(agentTurns.taskRunId, id), inArray(agentTurns.status, ['queued', 'running', 'waiting_approval']))).run()
        invalidateTools(tx, next)
        appendEvent(tx, next, 'generation_advanced')
        tx.insert(auditEvents).values({ id: randomUUID(), channelId: next.channelId, taskRunId: id,
          eventType: 'task_run_generation_changed', metadataJson: JSON.stringify({ generation: next.generation }), createdAt: new Date().toISOString() }).run()
        return next
      })
    },
    async listAgents(): Promise<Agent[]> {
      return client.db.select().from(agents).orderBy(asc(agents.createdAt), asc(agents.id)).all()
    },

    async getAgent(id: string): Promise<Agent | undefined> {
      return client.db.select().from(agents).where(eq(agents.id, id)).get()
    },

    async createAgent(input: AgentEditorInput): Promise<Agent> {
      const timestamp = new Date().toISOString()
      return client.db.insert(agents).values({ ...input, id: randomUUID(), isBuiltin: false, createdAt: timestamp, updatedAt: timestamp }).returning().get()
    },

    async updateAgent(id: string, input: AgentEditorInput): Promise<Agent | undefined> {
      return client.db.transaction((tx) => {
        const agent = tx.update(agents).set({ ...input, updatedAt: new Date().toISOString() }).where(eq(agents.id, id)).returning().get()
        invalidateChangedToolPolicies(tx, eq(toolExecutions.agentId, id))
        return agent
      })
    },

    async removeAgent(id: string): Promise<void> {
      client.db.transaction((tx) => {
        if (tx.select().from(channelAgents).where(eq(channelAgents.agentId, id)).get()) throw new Error('Agent 仍被群聊引用')
        tx.delete(agents).where(eq(agents.id, id)).run()
      })
    },

    async listChannelAgents(channelId: string): Promise<ChannelAgent[]> {
      return client.db.select().from(channelAgents).where(eq(channelAgents.channelId, channelId))
        .orderBy(asc(channelAgents.createdAt), asc(channelAgents.agentId)).all()
    },

    async saveChannelAgent(input: SaveChannelAgentInput): Promise<ChannelAgent> {
      const timestamp = new Date().toISOString()
      return client.db.transaction((tx) => {
        const previous = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.agentId, input.agentId))).get()
        if (previous && previous.isEnabled === input.isEnabled && previous.modelConfigOverrideId === input.modelConfigOverrideId
          && JSON.stringify(previous.toolPermissionsOverride === null ? null : sortedPermissions(previous.toolPermissionsOverride))
            === JSON.stringify(input.toolPermissionsOverride === null ? null : sortedPermissions(input.toolPermissionsOverride))) return previous
        const member = tx.insert(channelAgents).values({ ...input, revision: randomUUID(), createdAt: timestamp, updatedAt: timestamp })
          .onConflictDoUpdate({ target: [channelAgents.channelId, channelAgents.agentId], set: { ...input, revision: randomUUID(), updatedAt: timestamp } })
          .returning().get()
        invalidateChangedToolPolicies(tx, eq(taskRuns.channelId, input.channelId))
        return member
      })
    },

    async removeChannelAgent(channelId: string, agentId: string): Promise<void> {
      client.db.transaction((tx) => {
        tx.delete(channelAgents).where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId))).run()
        invalidateChangedToolPolicies(tx, and(eq(taskRuns.channelId, channelId), eq(toolExecutions.agentId, agentId))!)
      })
    },

    async listProjects(): Promise<Project[]> {
      return client.db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id)).all()
    },

    async createProjectWithInitialChannel(input: CreateProjectInput): Promise<{ project: Project; channel: Channel }> {
      const timestamp = new Date().toISOString()
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        icon: input.icon ?? null,
        workspacePath: input.workspacePath,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const channel: Channel = {
        id: randomUUID(),
        projectId: project.id,
        name: input.firstChannelName?.trim() || '主线任务协同群',
        icon: null,
        speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      client.db.transaction((tx) => {
        tx.insert(projects).values(project).run()
        tx.insert(channels).values(channel).run()
      })

      return { project, channel }
    },

    async listChannels(projectId: string): Promise<Channel[]> {
      return client.db.select().from(channels)
        .where(eq(channels.projectId, projectId))
        .orderBy(asc(channels.createdAt), asc(channels.id))
        .all()
    },

    async createChannel(input: CreateChannelInput): Promise<Channel> {
      const timestamp = new Date().toISOString()
      const channel: Channel = {
        id: randomUUID(),
        projectId: input.projectId,
        name: input.name,
        icon: input.icon ?? null,
        speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      client.db.insert(channels).values(channel).run()
      return channel
    },

    async getChannel(id: string): Promise<Channel | undefined> {
      return client.db.select().from(channels).where(eq(channels.id, id)).get()
    },

    async setChannelScheduler(id, modelConfigId) {
      return client.db.transaction((tx) => {
        const channel = tx.select().from(channels).where(eq(channels.id, id)).get()
        if (!channel || (modelConfigId !== null && !tx.select().from(modelConfigs).where(eq(modelConfigs.id, modelConfigId)).get())) throw new Error('群聊或调度模型不存在')
        return tx.update(channels).set({ schedulerModelConfigId: modelConfigId, updatedAt: new Date().toISOString() }).where(eq(channels.id, id)).returning().get()!
      })
    },

    async listTaskRuns(channelId: string): Promise<TaskRun[]> {
      return client.db.select().from(taskRuns).where(eq(taskRuns.channelId, channelId))
        .orderBy(asc(taskRuns.createdAt), asc(taskRuns.id)).all()
    },

    async createStartedTaskRun(input: StartTaskRunInput): Promise<TaskRun> {
      const timestamp = new Date().toISOString()
      const queuedRun: TaskRun = {
        id: randomUUID(),
        channelId: input.channelId,
        modelConfigId: input.modelConfigId,
        status: 'queued',
        generation: 0,
        currentTurnId: null, turnCount: 0, pauseReason: null,
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        createdAt: timestamp,
      }
      const message: Message = {
        id: randomUUID(),
        channelId: input.channelId,
        taskRunId: queuedRun.id,
        agentId: null, origin: 'ceo', taskRunSeq: 1,
        role: 'ceo',
        authorName: 'CEO',
        content: input.content,
        status: 'sent',
        createdAt: timestamp,
      }
      const auditEvent: AuditEvent = {
        id: randomUUID(),
        channelId: input.channelId,
        taskRunId: queuedRun.id,
        eventType: 'task_run_started',
        metadataJson: JSON.stringify({ messageId: message.id }),
        createdAt: timestamp,
      }

      return client.db.transaction((tx) => {
        if (tx.select().from(taskRuns).where(and(eq(taskRuns.channelId, input.channelId), inArray(taskRuns.status, ['running', 'cancelling', 'paused']))).get()) {
          throw new Error('请先继续或结束当前任务')
        }
        const channel = tx.select().from(channels).where(eq(channels.id, input.channelId)).get()
        if (!channel || !Array.isArray(input.mentions ?? []) || (input.mentions?.length ?? 0) > channel.maxTurns) throw new Error('Agent 提及无效')
        const enabled = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.isEnabled, true))).all()
        const names = enabled.map((member) => tx.select().from(agents).where(eq(agents.id, member.agentId)).get()?.name)
        const selected: string[] = []
        let end = -1
        for (const token of input.mentions ?? []) {
          if (!token || typeof token.agentId !== 'string' || !Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end)
            || token.start < end || token.start < 0 || token.end > input.content.length || token.end <= token.start
            || typeof token.text !== 'string' || input.content.slice(token.start, token.end) !== token.text) throw new Error('Agent 提及无效')
          const member = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.agentId, token.agentId))).get()
          const agent = tx.select().from(agents).where(eq(agents.id, token.agentId)).get()
          if (!member?.isEnabled || !agent || token.text !== `@${agent.name}` || names.filter((name) => name === agent.name).length !== 1) throw new Error('Agent 提及无效')
          if (!selected.includes(token.agentId)) selected.push(token.agentId)
          end = token.end
        }
        tx.insert(taskRuns).values(queuedRun).run()
        const runningRun = tx.update(taskRuns)
          .set({ status: 'running', startedAt: timestamp })
          .where(and(eq(taskRuns.id, queuedRun.id), eq(taskRuns.status, 'queued')))
          .returning()
          .get()
        if (!runningRun) throw new Error('TaskRun cannot transition from queued to running')
        tx.insert(messages).values(message).run()
        appendEvent(tx, runningRun, 'ceo_message', { messageId: message.id })
        selected.forEach((agentId, position) => {
          tx.insert(mentionQueue).values({ taskRunId: runningRun.id, position: position + 1, agentId, sourceMessageId: message.id, source: 'ceo', status: 'pending' }).run()
          appendEvent(tx, runningRun, 'mention_queued', { agentId, messageId: message.id })
        })
        tx.insert(auditEvents).values(auditEvent).run()
        return runningRun
      })
    },

    async getTaskRun(id: string): Promise<TaskRun | undefined> {
      return client.db.select().from(taskRuns).where(eq(taskRuns.id, id)).get()
    },

    async transitionTaskRun(
      id: string,
      from: 'running',
      to: 'completed' | 'failed' | 'cancelled',
      metadata: Record<string, string>,
    ): Promise<TaskRun | undefined> {
      const timestamp = new Date().toISOString()
      return client.db.transaction((tx) => {
        const current = tx.select().from(taskRuns).where(eq(taskRuns.id, id)).get()
        if (!current || current.status !== from) return undefined
        const next = tx.update(taskRuns)
          .set({
            status: to,
            generation: current.generation + 1,
            finishedAt: to === 'completed' || to === 'failed' || to === 'cancelled' ? timestamp : current.finishedAt,
            errorMessage: to === 'failed' ? metadata.errorMessage ?? 'TaskRun failed' : current.errorMessage,
            currentTurnId: null,
          })
          .where(and(eq(taskRuns.id, id), eq(taskRuns.status, from)))
          .returning()
          .get()
        if (!next) return undefined
        tx.update(agentTurns).set({ status: 'cancelled', finishedAt: timestamp })
          .where(and(eq(agentTurns.taskRunId, id), inArray(agentTurns.status, ['queued', 'running', 'waiting_approval']))).run()
        invalidateTools(tx, next)
        if (to === 'completed' && metadata.result !== undefined) {
          const reply = tx.insert(messages).values({
            id: randomUUID(), channelId: next.channelId, taskRunId: next.id,
            role: 'agent', authorName: 'AI 助手', content: metadata.result ?? '',
            agentId: null, origin: 'legacy', taskRunSeq: null,
            status: 'completed', createdAt: timestamp,
          }).returning().get()
          appendEvent(tx, next, 'task_completed', { messageId: reply.id, metadata: { reason: 'completed' } })
        } else if (to === 'completed') {
          appendEvent(tx, next, 'task_completed', { metadata: { reason: 'completed' } })
        } else {
          appendEvent(tx, next, to === 'failed' ? 'task_failed' : 'task_cancelled', { metadata: to === 'cancelled' ? { reason: 'cancelled' } : {} })
        }
        tx.insert(auditEvents).values({
          id: randomUUID(),
          channelId: next.channelId,
          taskRunId: next.id,
          eventType: `task_run_${to}`,
          metadataJson: JSON.stringify({ generation: next.generation }),
          createdAt: timestamp,
        }).run()
        return next
      })
    },

    async recoverRunningTaskRuns(): Promise<number> {
      const timestamp = new Date().toISOString()
      return client.db.transaction((tx) => {
        const runningRuns = tx.select().from(taskRuns).where(inArray(taskRuns.status, ['running', 'cancelling'])).all()
        for (const run of runningRuns) {
          const paused = tx.update(taskRuns)
            .set({ status: 'paused', generation: run.generation + 1, pauseReason: 'restart_recovery', currentTurnId: null })
            .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, run.status)))
            .returning().get()!
          tx.update(agentTurns).set({ status: 'cancelled', finishedAt: timestamp })
            .where(and(eq(agentTurns.taskRunId, run.id), inArray(agentTurns.status, ['queued', 'running', 'waiting_approval']))).run()
          invalidateTools(tx, paused)
          appendEvent(tx, paused, 'task_paused', { metadata: { reason: 'restart_recovery' } })
          tx.insert(auditEvents).values({
            id: randomUUID(),
            channelId: run.channelId,
            taskRunId: run.id,
            eventType: 'task_run_paused',
            metadataJson: JSON.stringify({ reason: 'restart_recovery' }),
            createdAt: timestamp,
          }).run()
        }
        return runningRuns.length
      })
    },

    async appendTaskRunEvent(id, generation, eventType, refs = {}) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, id)).get()
        if (!run || run.status !== 'running' || run.generation !== generation) throw new Error('任务事件已失效')
        return appendEvent(tx, run, eventType, refs)
      })
    },
    async listTaskRunEvents(id) {
      return client.db.select().from(taskRunEvents).where(eq(taskRunEvents.taskRunId, id)).orderBy(asc(taskRunEvents.seq)).all()
    },
    async startNextMentionTurn(taskRunId, generation) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()
        if (!run || run.status !== 'running' || run.generation !== generation || run.currentTurnId) throw new Error('任务轮次不可开始')
        const next = tx.select().from(mentionQueue).where(and(eq(mentionQueue.taskRunId, taskRunId), eq(mentionQueue.status, 'pending')))
          .orderBy(asc(mentionQueue.position)).limit(1).get()
        if (!next) return undefined
        const member = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.agentId, next.agentId))).get()
        if (!member?.isEnabled) throw new Error('待指派 Agent 已停用')
        const decision = appendEvent(tx, run, 'speaker_decided', { agentId: next.agentId, metadata: { reason: 'manual_selection' } })
        const turn = selectedTurn(tx, run, next.agentId, decision.seq)
        tx.update(mentionQueue).set({ status: 'consumed' }).where(and(eq(mentionQueue.taskRunId, taskRunId), eq(mentionQueue.position, next.position))).run()
        appendEvent(tx, run, 'mention_consumed', { agentId: next.agentId, messageId: next.sourceMessageId })
        return turn
      })
    },
    async startSingleMemberTurn(taskRunId, generation) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()
        if (!run || run.status !== 'running' || run.generation !== generation || run.currentTurnId || run.turnCount !== 0) throw new Error('任务轮次不可开始')
        const enabled = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.isEnabled, true))).all()
        if (enabled.length !== 1) return undefined
        const decision = appendEvent(tx, run, 'speaker_decided', { agentId: enabled[0].agentId, metadata: { reason: 'manual_selection' } })
        return selectedTurn(tx, run, enabled[0].agentId, decision.seq)
      })
    },
    async commitSpeakerDecision(input) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, input.taskRunId)).get()
        const channel = run && tx.select().from(channels).where(eq(channels.id, run.channelId)).get()
        if (!run || run.status !== 'running' || run.generation !== input.generation || run.currentTurnId || channel?.speakerMode !== 'automatic'
          || channel.schedulerModelConfigId !== input.modelConfigId) throw new Error('调度决策已失效')
        const members = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.isEnabled, true))).all()
        if (members.length !== Object.keys(input.memberRevisions).length || members.some((member) => input.memberRevisions[member.agentId] !== member.revision)) throw new Error('群聊成员已变化')
        if (tx.select().from(mentionQueue).where(and(eq(mentionQueue.taskRunId, run.id), eq(mentionQueue.status, 'pending'))).get()
          || tx.select().from(toolExecutions).where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.status, ['executing', 'waiting_approval']))).get()
          || tx.select().from(approvalRequests).innerJoin(toolExecutions, eq(approvalRequests.toolExecutionId, toolExecutions.id))
            .where(and(eq(toolExecutions.taskRunId, run.id), inArray(approvalRequests.status, ['pending', 'approved']))).get()) throw new Error('任务仍有待处理事项')
        if (input.nextSpeaker === null) {
          if (tx.select().from(toolExecutions).where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.toolName, ['write_file', 'replace_file_content', 'run_process']), eq(toolExecutions.status, 'completed'))).get()) throw new Error('任务有待验收产物')
          appendEvent(tx, run, 'speaker_decided', { metadata: { reason: 'automatic_complete' }, displayReason: input.reason })
          tx.update(taskRuns).set({ status: 'completed', finishedAt: new Date().toISOString() }).where(eq(taskRuns.id, run.id)).run()
          appendEvent(tx, run, 'task_completed')
          return null
        }
        if (!members.some((member) => member.agentId === input.nextSpeaker)) throw new Error('调度 Agent 已失效')
        const decision = appendEvent(tx, run, 'speaker_decided', { agentId: input.nextSpeaker, metadata: { reason: 'automatic_selection' }, displayReason: input.reason })
        return selectedTurn(tx, run, input.nextSpeaker, decision.seq)
      })
    },
    async markAgentTurnWaiting(id, toolExecutionId) {
      return client.db.transaction((tx) => {
        const turn = tx.select().from(agentTurns).where(eq(agentTurns.id, id)).get()
        const run = turn && tx.select().from(taskRuns).where(eq(taskRuns.id, turn.taskRunId)).get()
        if (!turn || !run || turn.status !== 'running' || run.status !== 'running' || run.currentTurnId !== id || run.generation !== turn.generation) throw new Error('任务轮次已失效')
        const execution = tx.select().from(toolExecutions).where(and(eq(toolExecutions.id, toolExecutionId), eq(toolExecutions.taskRunId, run.id), eq(toolExecutions.agentId, turn.agentId), eq(toolExecutions.generation, turn.generation))).get()
        if (!execution || !tx.select().from(approvalRequests).where(eq(approvalRequests.toolExecutionId, toolExecutionId)).get()) throw new Error('审批状态无效')
        const waiting = tx.update(agentTurns).set({ status: 'waiting_approval' }).where(eq(agentTurns.id, id)).returning().get()!
        appendEvent(tx, run, 'tool_waiting', { agentId: turn.agentId })
        return waiting
      })
    },
    async pauseTaskRun(id, reason) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, id)).get()
        if (!run || run.status !== 'running' || run.currentTurnId) throw new Error('任务不可暂停')
        const paused = tx.update(taskRuns).set({ status: 'paused', generation: run.generation + 1, pauseReason: reason }).where(eq(taskRuns.id, id)).returning().get()!
        appendEvent(tx, paused, 'task_paused')
        return paused
      })
    },
    async startAgentTurn(taskRunId, generation, agentId, triggerEventSeq) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, taskRunId)).get()
        if (!run || run.generation !== generation) throw new Error('任务轮次不可开始')
        return selectedTurn(tx, run, agentId, triggerEventSeq)
      })
    },
    async completeAgentTurn(id, content) {
      return client.db.transaction((tx) => {
        const turn = tx.select().from(agentTurns).where(eq(agentTurns.id, id)).get()
        const run = turn && tx.select().from(taskRuns).where(eq(taskRuns.id, turn.taskRunId)).get()
        if (!turn || !run || turn.status !== 'running' || run.status !== 'running' || run.generation !== turn.generation || run.currentTurnId !== id) throw new Error('任务轮次已失效')
        if (tx.select().from(toolExecutions).where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.status, ['executing', 'waiting_approval']))).get()) throw new Error('任务仍有未完成操作')
        if (!content.trim()) throw new Error('Agent 回复为空')
        const agent = tx.select().from(agents).where(eq(agents.id, turn.agentId)).get()
        const member = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.agentId, turn.agentId))).get()
        if (!agent || !member?.isEnabled) throw new Error('Agent 已失去发言资格')
        const last = tx.select({ seq: taskRunEvents.seq }).from(taskRunEvents)
          .where(eq(taskRunEvents.taskRunId, run.id)).orderBy(sql`${taskRunEvents.seq} DESC`).limit(1).get()
        const timestamp = new Date().toISOString()
        const message: Message = { id: randomUUID(), channelId: run.channelId, taskRunId: run.id,
          agentId: turn.agentId, origin: 'agent', taskRunSeq: (last?.seq ?? 0) + 1,
          role: 'agent', authorName: agent.name, content, status: 'completed', createdAt: timestamp }
        tx.insert(messages).values(message).run()
        const finished = tx.update(agentTurns).set({ status: 'completed', messageId: message.id, finishedAt: timestamp }).where(eq(agentTurns.id, id)).returning().get()!
        tx.update(taskRuns).set({ currentTurnId: null }).where(eq(taskRuns.id, run.id)).run()
        appendEvent(tx, run, 'turn_completed', { agentId: turn.agentId, messageId: message.id, metadata: { ordinal: turn.ordinal } })
        const members = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.isEnabled, true))).all()
        const allAgents = tx.select().from(agents).all()
        const suggestions = parseAgentMentions(message.content, turn.agentId, members, allAgents)
        const lastPosition = tx.select({ position: mentionQueue.position }).from(mentionQueue).where(eq(mentionQueue.taskRunId, run.id))
          .orderBy(sql`${mentionQueue.position} DESC`).limit(1).get()?.position ?? 0
        suggestions.forEach((agentId, index) => {
          tx.insert(mentionQueue).values({ taskRunId: run.id, position: lastPosition + index + 1, agentId, sourceMessageId: message.id, source: 'agent', status: 'pending' }).run()
          appendEvent(tx, run, 'mention_queued', { agentId, messageId: message.id })
        })
        return { turn: finished, message }
      })
    },
    async finishAgentTurn(id, status) {
      return client.db.transaction((tx) => {
        const turn = tx.select().from(agentTurns).where(eq(agentTurns.id, id)).get()
        const run = turn && tx.select().from(taskRuns).where(eq(taskRuns.id, turn.taskRunId)).get()
        if (!turn || !run || turn.status !== 'running' || run.status !== 'running' || run.generation !== turn.generation || run.currentTurnId !== id) throw new Error('任务轮次已失效')
        const finished = tx.update(agentTurns).set({ status, finishedAt: new Date().toISOString() }).where(eq(agentTurns.id, id)).returning().get()!
        tx.update(taskRuns).set({ currentTurnId: null }).where(eq(taskRuns.id, run.id)).run()
        appendEvent(tx, run, status === 'cancelled' ? 'turn_cancelled' : 'turn_failed', { agentId: turn.agentId, metadata: { ordinal: turn.ordinal } })
        return finished
      })
    },
    async listAgentTurns(taskRunId) {
      return client.db.select().from(agentTurns).where(eq(agentTurns.taskRunId, taskRunId)).orderBy(asc(agentTurns.ordinal)).all()
    },

    async listMessages(channelId: string): Promise<Message[]> {
      return client.db.select().from(messages)
        .where(eq(messages.channelId, channelId))
        .orderBy(
          sql`CASE WHEN ${messages.taskRunSeq} IS NOT NULL THEN (SELECT created_at FROM task_runs WHERE id = ${messages.taskRunId}) ELSE ${messages.createdAt} END`,
          sql`CASE WHEN ${messages.taskRunSeq} IS NOT NULL THEN ${messages.taskRunId} ELSE ${messages.id} END`,
          sql`CASE WHEN ${messages.taskRunSeq} IS NOT NULL THEN ${messages.taskRunSeq} ELSE 0 END`,
          asc(messages.id),
        )
        .all()
    },

    async listAuditEvents(channelId: string): Promise<AuditEvent[]> {
      return client.db.select().from(auditEvents)
        .where(eq(auditEvents.channelId, channelId))
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
        .all()
    },

    async saveModelConfig(input: SaveModelConfigRecordInput): Promise<ModelConfigRecord> {
      validateModelBudget(input)
      const timestamp = new Date().toISOString()
      const modelConfig: ModelConfigRecord = {
        id: randomUUID(),
        ...input,
        contextWindow: input.contextWindow ?? null,
        maxOutputTokens: input.maxOutputTokens ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      client.db.insert(modelConfigs).values(modelConfig).run()
      return modelConfig
    },

    async listModelConfigs(): Promise<ModelConfigRecord[]> {
      return client.db.select().from(modelConfigs)
        .orderBy(asc(modelConfigs.createdAt), asc(modelConfigs.id))
        .all()
    },

    async getModelConfig(id: string): Promise<ModelConfigRecord | undefined> {
      return client.db.select().from(modelConfigs).where(eq(modelConfigs.id, id)).get()
    },

    async recordCloudConsent(projectId: string, modelConfigId: string): Promise<void> {
      client.db.insert(cloudConsents).values({
        projectId,
        modelConfigId,
        consentedAt: new Date().toISOString(),
      }).onConflictDoUpdate({
        target: [cloudConsents.projectId, cloudConsents.modelConfigId],
        set: { consentedAt: new Date().toISOString() },
      }).run()
    },

    async hasCloudConsent(projectId: string, modelConfigId: string): Promise<boolean> {
      return client.db.select({ projectId: cloudConsents.projectId }).from(cloudConsents)
        .where(and(eq(cloudConsents.projectId, projectId), eq(cloudConsents.modelConfigId, modelConfigId)))
        .get() !== undefined
    },
    async recordToolResultConsent(projectId, modelConfigId, scopeVersion) { client.db.insert(toolResultConsents).values({ projectId, modelConfigId, scopeVersion, consentedAt: new Date().toISOString() }).run() },
    async hasToolResultConsent(projectId, modelConfigId, scopeVersion) { return client.db.select().from(toolResultConsents).where(and(eq(toolResultConsents.projectId, projectId), eq(toolResultConsents.modelConfigId, modelConfigId), eq(toolResultConsents.scopeVersion, scopeVersion))).get() !== undefined },
  }
}
