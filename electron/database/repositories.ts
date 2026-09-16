import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import type {
  AuditEvent,
  Channel,
  CreateChannelInput,
  CreateProjectInput,
  Message,
  ModelProviderPreset,
  Project,
  TaskRun,
} from '../../shared/types'
import type { DatabaseClient } from './client'
import { auditEvents, channels, cloudConsents, messages, modelConfigs, projects, taskRuns } from './schema'

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
  listProjects(): Promise<Project[]>
  createProjectWithInitialChannel(input: CreateProjectInput): Promise<{ project: Project; channel: Channel }>
  listChannels(projectId: string): Promise<Channel[]>
  createChannel(input: CreateChannelInput): Promise<Channel>
  createStartedTaskRun(input: StartTaskRunInput): Promise<TaskRun>
  getTaskRun(id: string): Promise<TaskRun | undefined>
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
        name: input.firstChannelName ?? '主线任务协同群',
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

    async createStartedTaskRun(input: StartTaskRunInput): Promise<TaskRun> {
      const timestamp = new Date().toISOString()
      const queuedRun: TaskRun = {
        id: randomUUID(),
        channelId: input.channelId,
        modelConfigId: input.modelConfigId,
        status: 'queued',
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
            finishedAt: to === 'completed' || to === 'failed' || to === 'cancelled' ? timestamp : current.finishedAt,
            errorMessage: to === 'failed' ? metadata.errorMessage ?? 'TaskRun failed' : current.errorMessage,
          })
          .where(and(eq(taskRuns.id, id), eq(taskRuns.status, from)))
          .returning()
          .get()
        if (!next) return undefined
        tx.insert(auditEvents).values({
          id: randomUUID(),
          channelId: next.channelId,
          taskRunId: next.id,
          eventType: `task_run_${to}`,
          metadataJson: JSON.stringify(metadata),
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
            .set({ status: 'paused' })
            .where(and(eq(taskRuns.id, run.id), eq(taskRuns.status, 'running')))
            .run()
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
