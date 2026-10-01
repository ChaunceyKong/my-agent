import type { CeoMentionToken, TaskRun } from '../../shared/types'
import type { Repositories } from '../database/repositories'

export interface TaskRunService {
  startTaskRun(channelId: string, modelConfigId: string, content: string, mentions?: CeoMentionToken[]): Promise<TaskRun>
  cancelTaskRun(id: string): Promise<TaskRun>
  finishTaskRun(id: string, result: string): Promise<TaskRun>
  recoverInterruptedTaskRuns(): Promise<number>
  canAcceptChunk(id: string, generation?: number): Promise<boolean>
  advanceGeneration(id: string): Promise<TaskRun>
  onCancelled(id: string, listener: () => void): () => void
}

export function createTaskRunService(repositories: Repositories): TaskRunService {
  const cancellationListeners = new Map<string, Set<() => void>>()
  return {
    startTaskRun: (channelId, modelConfigId, content, mentions) => repositories.createStartedTaskRun({
      channelId,
      modelConfigId,
      content,
      mentions,
    }),

    async cancelTaskRun(id: string): Promise<TaskRun> {
      const run = await transition(repositories, id, 'cancelled', {})
      for (const listener of cancellationListeners.get(id) ?? []) listener()
      cancellationListeners.delete(id)
      return run
    },

    onCancelled(id, listener) {
      const listeners = cancellationListeners.get(id) ?? new Set<() => void>()
      listeners.add(listener)
      cancellationListeners.set(id, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) cancellationListeners.delete(id)
      }
    },

    async finishTaskRun(id: string, result: string): Promise<TaskRun> {
      return transition(repositories, id, 'completed', { result })
    },

    recoverInterruptedTaskRuns: () => repositories.recoverRunningTaskRuns(),

    advanceGeneration: (id) => repositories.advanceTaskRunGeneration(id),

    async canAcceptChunk(id: string, generation?: number): Promise<boolean> {
      const run = await repositories.getTaskRun(id)
      return run?.status === 'running' && (generation === undefined || run.generation === generation)
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
