import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTaskRunService, type TaskRunService } from '../../electron/core/task-run-service'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'

let database: DatabaseClient
let repositories: Repositories
let taskRuns: TaskRunService
let testDirectory: string
let workspaceDirectory: string
let databasePath: string

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'agent-team-task-run-'))
  workspaceDirectory = await mkdtemp(join(tmpdir(), 'agent-team-task-workspace-'))
  databasePath = join(testDirectory, 'agent-team.sqlite')
  database = createDatabase({ filePath: databasePath })
  repositories = createRepositories(database)
  taskRuns = createTaskRunService(repositories)
})

afterEach(async () => {
  database.close()
  await Promise.all([
    rm(testDirectory, { force: true, recursive: true }),
    rm(workspaceDirectory, { force: true, recursive: true }),
  ])
})

async function createChannel(): Promise<string> {
  const { channel } = await repositories.createProjectWithInitialChannel({
    name: '任务项目',
    workspacePath: await realpath(workspaceDirectory),
  })
  return channel.id
}

describe('task run service', () => {
  it('changes running runs to paused during restart recovery', async () => {
    const channelId = await createChannel()
    const run = await taskRuns.startTaskRun(channelId, 'model-1', '请分析')

    database.close()
    database = createDatabase({ filePath: databasePath })
    repositories = createRepositories(database)
    taskRuns = createTaskRunService(repositories)

    const recovered = await taskRuns.recoverInterruptedTaskRuns()

    expect(recovered).toBe(1)
    expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused' })
    expect(await taskRuns.canAcceptChunk(run.id)).toBe(false)
  })

  it('rejects chunks after cancellation and completion', async () => {
    const channelId = await createChannel()
    const cancelledRun = await taskRuns.startTaskRun(channelId, 'model-1', '请分析')
    await taskRuns.cancelTaskRun(cancelledRun.id)

    const completedRun = await taskRuns.startTaskRun(channelId, 'model-1', '请总结')
    await taskRuns.finishTaskRun(completedRun.id, '已完成')

    expect(await taskRuns.canAcceptChunk(cancelledRun.id)).toBe(false)
    expect(await taskRuns.canAcceptChunk(completedRun.id)).toBe(false)
    expect(await repositories.listAuditEvents(channelId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskRunId: cancelledRun.id, eventType: 'task_run_cancelled' }),
      expect.objectContaining({ taskRunId: completedRun.id, eventType: 'task_run_completed' }),
    ]))
  })

  it('rejects illegal transitions from terminal runs', async () => {
    const channelId = await createChannel()
    const run = await taskRuns.startTaskRun(channelId, 'model-1', '请分析')
    await taskRuns.cancelTaskRun(run.id)

    await expect(taskRuns.cancelTaskRun(run.id)).rejects.toThrow('TaskRun cannot transition from cancelled to cancelled')
    await expect(taskRuns.finishTaskRun(run.id, '迟到结果')).rejects.toThrow('TaskRun cannot transition from cancelled to completed')
  })

  it('persists the CEO message, running task run, and audit event from message:send', async () => {
    const channelId = await createChannel()
    const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
    registerHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      repositories,
      taskRuns,
    })

    const result = await handlers.get(IpcChannel.MessageSend)?.(undefined, {
      channelId,
      modelConfigId: 'model-1',
      content: '请分析',
    })

    expect(result).toEqual({ taskRunId: expect.any(String) })
    const taskRunId = (result as { taskRunId: string }).taskRunId
    expect(await repositories.listMessages(channelId)).toEqual([
      expect.objectContaining({ channelId, taskRunId, role: 'ceo', authorName: 'CEO', content: '请分析' }),
    ])
    expect(await repositories.getTaskRun(taskRunId)).toMatchObject({ channelId, modelConfigId: 'model-1', status: 'running' })
    expect(await repositories.listAuditEvents(channelId)).toEqual([
      expect.objectContaining({ channelId, taskRunId, eventType: 'task_run_started' }),
    ])
  })
})
