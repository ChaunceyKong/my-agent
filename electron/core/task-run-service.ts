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
  trackEffect<T>(id: string, effect: () => Promise<T>): Promise<T>
  hasActiveEffects(id: string): boolean
  pauseTaskRun(id: string, reason: string, expectedGeneration?: number): Promise<TaskRun>
  resumeTaskRun(id: string, agentId?: string): Promise<TaskRun>
  acknowledgeProcessRecovery(id: string, executionId: string): Promise<void>
}

export function createTaskRunService(repositories: Repositories, cleanupTimeoutMs = 5_000): TaskRunService {
  const cancellationListeners = new Map<string, Set<() => void>>()
  const effects = new Map<string, Set<Promise<unknown>>>()
  const stopping = new Map<string, Promise<TaskRun>>()
  async function stop(id: string, reason?: string, expectedGeneration?: number): Promise<TaskRun> {
    const pending = stopping.get(id)
    if (pending) return pending
    const operation = (async () => {
      await repositories.beginTaskRunCancellation(id, expectedGeneration)
      for (const listener of cancellationListeners.get(id) ?? []) listener()
      cancellationListeners.delete(id)
      let timer: ReturnType<typeof setTimeout> | undefined
      const settled = await Promise.race([
        Promise.allSettled([...(effects.get(id) ?? [])]).then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs) }),
      ])
      clearTimeout(timer)
      return repositories.settleTaskRunCancellation(id, settled, reason)
    })()
    stopping.set(id, operation)
    try { return await operation } finally { stopping.delete(id) }
  }
  return {
    startTaskRun: (channelId, modelConfigId, content, mentions) => repositories.createStartedTaskRun({
      channelId,
      modelConfigId,
      content,
      mentions,
    }),

    async cancelTaskRun(id: string): Promise<TaskRun> {
      return stop(id)
    },
    pauseTaskRun: (id, reason, expectedGeneration) => stop(id, reason, expectedGeneration),
    async resumeTaskRun(id, agentId) {
      if (stopping.has(id) || effects.get(id)?.size) throw new Error('任务效果仍在清理')
      return repositories.resumeTaskRun(id, agentId)
    },
    async acknowledgeProcessRecovery(id, executionId) {
      if (stopping.has(id) || effects.get(id)?.size) throw new Error('任务效果仍在清理')
      await repositories.acknowledgeProcessRecovery(id, executionId)
    },
    async trackEffect(id, effect) {
      // Register before invoking the effect so cancellation cannot overlook an in-flight claim.
      const pending = Promise.resolve().then(effect)
      const active = effects.get(id) ?? new Set<Promise<unknown>>()
      active.add(pending); effects.set(id, active)
      try { return await pending } finally { active.delete(pending); if (!active.size) effects.delete(id) }
    },
    hasActiveEffects: (id) => stopping.has(id) || !!effects.get(id)?.size,

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
