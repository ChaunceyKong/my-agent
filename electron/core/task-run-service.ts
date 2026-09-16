import type { TaskRun } from '../../shared/types'
import type { Repositories } from '../database/repositories'

export interface TaskRunService {
  startTaskRun(channelId: string, modelConfigId: string, content: string): Promise<TaskRun>
  cancelTaskRun(id: string): Promise<TaskRun>
  finishTaskRun(id: string, result: string): Promise<TaskRun>
  recoverInterruptedTaskRuns(): Promise<number>
  canAcceptChunk(id: string): Promise<boolean>
}

export function createTaskRunService(repositories: Repositories): TaskRunService {
  return {
    startTaskRun: (channelId, modelConfigId, content) => repositories.createStartedTaskRun({
      channelId,
      modelConfigId,
      content,
    }),

    async cancelTaskRun(id: string): Promise<TaskRun> {
      return transition(repositories, id, 'cancelled', {})
    },

    async finishTaskRun(id: string, result: string): Promise<TaskRun> {
      return transition(repositories, id, 'completed', { result })
    },

    recoverInterruptedTaskRuns: () => repositories.recoverRunningTaskRuns(),

    async canAcceptChunk(id: string): Promise<boolean> {
      return (await repositories.getTaskRun(id))?.status === 'running'
    },
  }
}

async function transition(repositories: Repositories, id: string, to: 'cancelled' | 'completed', metadata: Record<string, string>): Promise<TaskRun> {
  const current = await repositories.getTaskRun(id)
  if (current?.status !== 'running') throw new Error(`TaskRun cannot transition from ${current?.status ?? 'missing'} to ${to}`)
  const next = await repositories.transitionTaskRun(id, 'running', to, metadata)
  if (!next) throw new Error(`TaskRun cannot transition from running to ${to}`)
  return next
}
