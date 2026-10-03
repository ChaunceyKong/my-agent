import { afterEach, beforeEach, expect, it } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { agentTurns, approvalRequests, overwritePublications, taskRuns, toolExecutions } from '../../electron/database/schema'
import type { AgentTurnStatus, ApprovalRequestStatus, OverwritePublicationState, TaskRunStatus, ToolExecutionStatus } from '../../shared/types'

let db: DatabaseClient; let repo: Repositories
beforeEach(async () => {
  db = createDatabase({ filePath: ':memory:' }); repo = createRepositories(db)
  const { channel } = await repo.createProjectWithInitialChannel({ name: 'other project', workspacePath: 'fixture' })
  const model = await repo.saveModelConfig({ providerPreset: 'ollama', baseUrl: 'http://localhost:11434', modelName: 'fixture', encryptedApiKey: '' })
  const agent = await repo.createAgent({ name: 'fixture', title: 'fixture', avatar: null, systemPrompt: 'fixture', modelConfigId: model.id, defaultToolPermissions: {} })
  const run = await repo.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'fixture' })
  db.db.update(taskRuns).set({ status: 'completed' }).run()
  db.db.insert(toolExecutions).values({ id: 'tool', taskRunId: run.id, generation: run.generation, agentId: agent.id, toolName: 'run_process', inputJson: '{}',
    riskLevel: 'high', requestHash: 'hash', policySnapshotJson: '{}', status: 'completed', createdAt: 'now', updatedAt: 'now' }).run()
  db.db.insert(approvalRequests).values({ id: 'approval', toolExecutionId: 'tool', requestHash: 'hash', generation: 0, policySnapshotJson: '{}', status: 'executing', expiresAt: 'later', createdAt: 'now' }).run()
  db.db.insert(agentTurns).values({ id: 'turn', taskRunId: run.id, ordinal: 1, agentId: agent.id, generation: 0, status: 'completed', triggerEventSeq: 1 }).run()
  db.db.insert(overwritePublications).values({ executionId: 'tool', temporaryRelativePath: 'fixture.tmp', backupRelativePath: 'fixture.backup', state: 'completed', createdAt: 'now', updatedAt: 'now' }).run()
})
afterEach(() => db.close())

it('completed effect with historical executing approval and closed journal is not a barrier', async () => {
  expect(await repo.hasUpdateBarriers()).toBe(false)
  db.db.update(toolExecutions).set({ status: 'failed' }).run()
  db.db.update(overwritePublications).set({ state: 'recovered' }).run()
  expect(await repo.hasUpdateBarriers()).toBe(false)
})
it.each(['queued', 'running', 'cancelling', 'paused', 'cancelled', 'failed', 'completed'] as TaskRunStatus[])('global Run status %s', async (status) => {
  db.db.update(taskRuns).set({ status }).run()
  expect(await repo.hasUpdateBarriers()).toBe(['queued', 'running', 'cancelling', 'paused'].includes(status))
})
it.each(['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'] as AgentTurnStatus[])('global Turn status %s', async (status) => {
  db.db.update(agentTurns).set({ status }).run()
  expect(await repo.hasUpdateBarriers()).toBe(['queued', 'running', 'waiting_approval'].includes(status))
})
it.each(['executing', 'waiting_approval', 'completed', 'failed', 'cancelled'] as ToolExecutionStatus[])('global Tool status %s', async (status) => {
  db.db.update(toolExecutions).set({ status }).run()
  expect(await repo.hasUpdateBarriers()).toBe(['executing', 'waiting_approval'].includes(status))
})
it.each(['pending', 'approved', 'executing', 'rejected', 'expired', 'cancelled'] as ApprovalRequestStatus[])('global Approval status %s for a terminal effect', async (status) => {
  db.db.update(approvalRequests).set({ status }).run()
  expect(await repo.hasUpdateBarriers()).toBe(['pending', 'approved'].includes(status))
})
it.each(['preparing', 'staged', 'publishing', 'effect_claimed', 'published', 'cleanup_pending', 'completed', 'needs_recovery', 'recovered'] as OverwritePublicationState[])('global publication journal %s including recovery', async (state) => {
  db.db.update(overwritePublications).set({ state }).run()
  expect(await repo.hasUpdateBarriers()).toBe(!['completed', 'recovered'].includes(state))
})
it('failed process with recovery required remains blocked independently of historical approval', async () => {
  db.db.update(toolExecutions).set({ status: 'failed', processRecoveryRequired: true }).run()
  db.db.update(approvalRequests).set({ status: 'cancelled' }).run()
  expect(await repo.hasUpdateBarriers()).toBe(true)
  expect((await repo.getToolExecution('tool'))?.processRecoveryRequired).toBe(true)
})
