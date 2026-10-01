import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase } from '../../electron/database/client'
import { createRepositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createApprovalService } from '../../electron/core/approval-service'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createProcessToolService } from '../../electron/core/process-tool-service'

vi.mock('../../electron/core/process-tool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../electron/core/process-tool')>()),
  executeRegisteredProcess: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '' }),
}))

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('records approved process completion without terminalizing the collaborative Run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-process-barrier-'))
  directories.push(directory)
  const database = createDatabase({ filePath: join(directory, 'test.sqlite') })
  try {
    const repositories = createRepositories(database)
    const { channel } = await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: directory })
    const model = await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'key' })
    const agent = await repositories.createAgent({ name: 'Agent', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id, defaultToolPermissions: { run_process: true } })
    await repositories.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    await repositories.saveRegisteredExecutable({ id: 'safe', absolutePath: 'C:\\safe\\tool.exe', isEnabled: true, argumentPolicyJson: '["status"]' })
    const run = await repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'check status' })
    const decision = await repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: agent.id })
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, decision.seq)
    const approvals = createApprovalService(repositories)
    const execution = (await createToolEngine(repositories, approvals).execute({ taskRunId: run.id, generation: run.generation, turnId: turn.id, agentId: agent.id },
      { toolName: 'run_process', input: { executableId: 'safe', args: ['status'] } })).execution
    await repositories.markAgentTurnWaiting(turn.id, execution.id)
    const approval = (await repositories.getApprovalForToolExecution(execution.id))!
    await approvals.approve(approval.id, approval.requestHash)
    await createProcessToolService(repositories, createTaskRunService(repositories)).runApproved(approval.id)
    expect(await repositories.getToolExecution(execution.id)).toMatchObject({ status: 'completed' })
    expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'running', currentTurnId: turn.id })
    expect((await repositories.listAgentTurns(run.id))[0].status).toBe('waiting_approval')
    expect((await repositories.listTaskRunEvents(run.id)).filter((event) => event.eventType === 'tool_decided')).toHaveLength(1)
    await expect(repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'next' })).rejects.toThrow('继续或结束')
  } finally { database.close() }
})
