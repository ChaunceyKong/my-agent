import { afterEach, expect, it } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories } from '../../electron/database/repositories'
import type { OverwritePublicationState } from '../../shared/types'

let db: DatabaseClient | undefined
afterEach(() => { db?.close(); db = undefined })
const states: OverwritePublicationState[] = ['preparing', 'staged', 'publishing', 'effect_claimed', 'published', 'cleanup_pending', 'needs_recovery']
const changes = ['model', 'member', 'permission', 'cancel'] as const

it.each(states.flatMap((state) => changes.map((change) => ({ state, change }))))('retains $state publication through $change until completion or recovery', async ({ state, change }) => {
  db = createDatabase({ filePath: ':memory:' })
  const repo = createRepositories(db)
  const { channel } = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: 'C:/test' })
  const modelInput = { providerPreset: 'openai' as const, baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'encrypted' }
  const model = await repo.saveModelConfig(modelInput)
  const agent = await repo.createAgent({ name: 'A', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id, defaultToolPermissions: { write_file: true } })
  const member = await repo.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const run = await repo.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'replace' })
  const context = { taskRunId: run.id, generation: run.generation, agentId: agent.id }
  const execution = await repo.createToolExecution(context, { toolName: 'replace_file_content', input: { path: 'a.md', content: 'replacement' } })
  const approval = await repo.createOverwriteApproval(execution.id, new Date(Date.now() + 60_000).toISOString(), JSON.stringify({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 }))
  await repo.decideApprovalRequest(approval.id, approval.requestHash, 'approved', new Date().toISOString())
  await repo.claimApprovedOverwrite(approval.id, new Date().toISOString(), '.agent-team-00000000-0000-0000-0000-000000000001.tmp', '.agent-team-00000000-0000-0000-0000-000000000001.backup')
  if (state !== 'preparing') await repo.markOverwriteStaged(execution.id, '{}')
  if (!['preparing', 'staged'].includes(state)) await repo.markOverwritePublishing(execution.id)
  if (['effect_claimed', 'published', 'cleanup_pending'].includes(state)) await repo.claimOverwriteEffect(execution.id)
  if (['published', 'cleanup_pending'].includes(state)) await repo.markOverwritePublished(execution.id)
  if (state === 'cleanup_pending') await repo.markOverwriteCleanupPending(execution.id)
  if (state === 'needs_recovery') await repo.recoverOverwritePublication(execution.id, 'needs_recovery', 'awaiting manual recovery')
  const priorStatus = (await repo.getToolExecution(execution.id))!.status

  if (change === 'model') await repo.updateModelConfig(model.id, { ...modelInput, modelName: 'changed' })
  if (change === 'member') await repo.saveChannelAgent({ ...member, isEnabled: false })
  if (change === 'permission') await repo.updateAgent(agent.id, { ...agent, defaultToolPermissions: {} })
  // This also exercises the shared invalidation path, not only policy-change invalidation.
  await repo.beginTaskRunCancellation(run.id, run.generation)
  expect((await repo.getToolExecution(execution.id))!.status).toBe(priorStatus)
  expect((await repo.getApprovalRequest(approval.id))!.status).toBe('executing')
  expect((await repo.settleTaskRunCancellation(run.id, true))).toMatchObject({ status: 'paused', pauseReason: 'effect_cleanup_pending' })
  await expect(repo.resumeTaskRun(run.id)).rejects.toThrow()
  await expect(repo.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'next' })).rejects.toThrow()

  if (['effect_claimed', 'published'].includes(state)) {
    if (state === 'effect_claimed') await repo.markOverwritePublished(execution.id)
    expect((await repo.completeOverwritePublication(execution.id)).status).toBe('completed')
    await repo.markOverwriteCleanupPending(execution.id)
    await repo.beginTaskRunCancellation(run.id)
    expect((await repo.settleTaskRunCancellation(run.id, true)).status).toBe('paused')
    await repo.markOverwriteCleanupComplete(execution.id)
  } else {
    expect((await repo.recoverOverwritePublication(execution.id, 'recovered', 'cleanup verified')).status).toBe('failed')
  }
  await repo.beginTaskRunCancellation(run.id)
  expect((await repo.settleTaskRunCancellation(run.id, true)).status).toBe('cancelled')
  expect((await repo.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'next' })).status).toBe('running')
})
