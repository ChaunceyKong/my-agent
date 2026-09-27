import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type {
  Agent,
  AgentEditorInput,
  AuditEvent,
  Channel,
  ChannelAgent,
  CreateChannelInput,
  CreateProjectInput,
  Message,
  ModelProviderPreset,
  Project,
  SaveChannelAgentInput,
  TaskRun,
  ToolExecution,
  ToolName,
  ToolPermissions,
  ToolPolicySnapshot,
  ToolRequest,
} from '../../shared/types'
import { hashToolRequest, toolAuditEvent } from '../core/audit-service'
import type { AppDatabase, DatabaseClient } from './client'
import { agents, auditEvents, channelAgents, channels, cloudConsents, messages, modelConfigs, projects, taskRuns, toolExecutions } from './schema'

export interface ToolContext {
  taskRunId: string
  generation: number
  agentId: string
  messageId?: string
}

export type ToolOutcome = Pick<ToolExecution, 'status' | 'riskLevel' | 'resultSummary'>
type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

function sortedPermissions(value: ToolPermissions): ToolPermissions {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
}

function currentPolicy(tx: Transaction, run: TaskRun, agentId: string, toolName: ToolName): string | undefined {
  const agent = tx.select().from(agents).where(eq(agents.id, agentId)).get()
  const member = tx.select().from(channelAgents).where(and(eq(channelAgents.channelId, run.channelId), eq(channelAgents.agentId, agentId))).get()
  const channel = tx.select().from(channels).where(eq(channels.id, run.channelId)).get()
  const project = channel && tx.select().from(projects).where(eq(projects.id, channel.projectId)).get()
  if (!agent || !member?.isEnabled || !project || agent.defaultToolPermissions[toolName] !== true
    || (member.toolPermissionsOverride !== null && member.toolPermissionsOverride[toolName] !== true)) return undefined
  const snapshot: ToolPolicySnapshot = {
    version: 1, workspacePath: project.workspacePath, agentId,
    defaultToolPermissions: sortedPermissions(agent.defaultToolPermissions),
    toolPermissionsOverride: member.toolPermissionsOverride === null ? null : sortedPermissions(member.toolPermissionsOverride),
  }
  return JSON.stringify(snapshot)
}

function invalidateTools(tx: Transaction, run: TaskRun): void {
  const invalidated = tx.update(toolExecutions).set({ status: 'cancelled', resultSummary: '任务操作已失效', updatedAt: new Date().toISOString() })
    .where(and(eq(toolExecutions.taskRunId, run.id), inArray(toolExecutions.status, ['executing', 'waiting_approval'])))
    .returning().all()
  for (const execution of invalidated) tx.insert(auditEvents).values(toolAuditEvent(run.channelId, execution)).run()
}

export interface StartTaskRunInput {
  channelId: string
  modelConfigId: string
  content: string
}

export interface SaveModelConfigRecordInput {
  providerPreset: ModelProviderPreset
  baseUrl: string
  modelName: string
  encryptedApiKey: string
}

export interface ModelConfigRecord extends SaveModelConfigRecordInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface Repositories {
  createToolExecution(context: ToolContext, request: ToolRequest): Promise<ToolExecution>
  getToolExecution(id: string): Promise<ToolExecution | undefined>
  listToolExecutions(taskRunId: string): Promise<ToolExecution[]>
  finishToolExecution(id: string, outcome: () => ToolOutcome): Promise<ToolExecution>
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
  createChannel(input: CreateChannelInput): Promise<Channel>
  createStartedTaskRun(input: StartTaskRunInput): Promise<TaskRun>
  getTaskRun(id: string): Promise<TaskRun | undefined>
  listTaskRuns(channelId: string): Promise<TaskRun[]>
  transitionTaskRun(id: string, from: 'running', to: 'completed' | 'failed' | 'cancelled', metadata: Record<string, string>): Promise<TaskRun | undefined>
  recoverRunningTaskRuns(): Promise<number>
  listMessages(channelId: string): Promise<Message[]>
  listAuditEvents(channelId: string): Promise<AuditEvent[]>
  saveModelConfig(input: SaveModelConfigRecordInput): Promise<ModelConfigRecord>
  listModelConfigs(): Promise<ModelConfigRecord[]>
  getModelConfig(id: string): Promise<ModelConfigRecord | undefined>
  recordCloudConsent(projectId: string, modelConfigId: string): Promise<void>
  hasCloudConsent(projectId: string, modelConfigId: string): Promise<boolean>
}

export function createRepositories(client: DatabaseClient): Repositories {
  return {
    async createToolExecution(context, request) {
      return client.db.transaction((tx) => {
        const run = tx.select().from(taskRuns).where(eq(taskRuns.id, context.taskRunId)).get()
        if (!run || run.status !== 'running' || run.generation !== context.generation) throw new Error('任务操作已失效')
        const policySnapshotJson = currentPolicy(tx, run, context.agentId, request.toolName)
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
          riskLevel: request.toolName === 'write_file' ? 'medium' : 'low', status: 'executing',
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
          && currentPolicy(tx, run, current.agentId, current.toolName) === current.policySnapshotJson
        const result: ToolOutcome = valid ? outcome() : { status: 'cancelled', riskLevel: current.riskLevel, resultSummary: '任务操作已失效' }
        const next = tx.update(toolExecutions).set({ ...result, updatedAt: new Date().toISOString() })
          .where(eq(toolExecutions.id, id)).returning().get()!
        tx.insert(auditEvents).values(toolAuditEvent(run.channelId, next)).run()
        return next
      })
    },

    async advanceTaskRunGeneration(id) {
      return client.db.transaction((tx) => {
        const current = tx.select().from(taskRuns).where(eq(taskRuns.id, id)).get()
        if (current?.status !== 'running') throw new Error('任务操作已失效')
        const next = tx.update(taskRuns).set({ generation: current.generation + 1 }).where(eq(taskRuns.id, id)).returning().get()!
        invalidateTools(tx, next)
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
      return client.db.update(agents).set({ ...input, updatedAt: new Date().toISOString() }).where(eq(agents.id, id)).returning().get()
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
        if (input.isEnabled) {
          tx.update(channelAgents).set({ isEnabled: false, updatedAt: timestamp })
            .where(and(eq(channelAgents.channelId, input.channelId), eq(channelAgents.isEnabled, true))).run()
        }
        return tx.insert(channelAgents).values({ ...input, createdAt: timestamp, updatedAt: timestamp })
          .onConflictDoUpdate({ target: [channelAgents.channelId, channelAgents.agentId], set: { ...input, updatedAt: timestamp } })
          .returning().get()
      })
    },

    async removeChannelAgent(channelId: string, agentId: string): Promise<void> {
      client.db.delete(channelAgents).where(and(eq(channelAgents.channelId, channelId), eq(channelAgents.agentId, agentId))).run()
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
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      client.db.insert(channels).values(channel).run()
      return channel
    },

    async getChannel(id: string): Promise<Channel | undefined> {
      return client.db.select().from(channels).where(eq(channels.id, id)).get()
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
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        createdAt: timestamp,
      }
      const message: Message = {
        id: randomUUID(),
        channelId: input.channelId,
        taskRunId: queuedRun.id,
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
        tx.insert(taskRuns).values(queuedRun).run()
        const runningRun = tx.update(taskRuns)
          .set({ status: 'running', startedAt: timestamp })
          .where(and(eq(taskRuns.id, queuedRun.id), eq(taskRuns.status, 'queued')))
          .returning()
          .get()
        if (!runningRun) throw new Error('TaskRun cannot transition from queued to running')
        tx.insert(messages).values(message).run()
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
          })
          .where(and(eq(taskRuns.id, id), eq(taskRuns.status, from)))
          .returning()
          .get()
        if (!next) return undefined
        invalidateTools(tx, next)
        if (to === 'completed') {
          tx.insert(messages).values({
            id: randomUUID(), channelId: next.channelId, taskRunId: next.id,
            role: 'agent', authorName: 'AI 助手', content: metadata.result ?? '',
            status: 'completed', createdAt: timestamp,
          }).run()
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
        const runningRuns = tx.select().from(taskRuns).where(eq(taskRuns.status, 'running')).all()
        for (const run of runningRuns) {
          tx.update(taskRuns)
            .set({ status: 'paused', generation: run.generation + 1 })
            .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'running')))
            .run()
          invalidateTools(tx, run)
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

    async listMessages(channelId: string): Promise<Message[]> {
      return client.db.select().from(messages)
        .where(eq(messages.channelId, channelId))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .all()
    },

    async listAuditEvents(channelId: string): Promise<AuditEvent[]> {
      return client.db.select().from(auditEvents)
        .where(eq(auditEvents.channelId, channelId))
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
        .all()
    },

    async saveModelConfig(input: SaveModelConfigRecordInput): Promise<ModelConfigRecord> {
      const timestamp = new Date().toISOString()
      const modelConfig: ModelConfigRecord = {
        id: randomUUID(),
        ...input,
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
  }
}
