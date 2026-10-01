import type { StreamEvent } from '../../shared/types'
import type { Repositories } from '../database/repositories'
import type { ModelClient } from './model-client'
import type { createSingleAgentRunner } from './single-agent-runner'
import type { TaskRunService } from './task-run-service'

/** One durable Turn at a time. Task 3 adds Agent handoffs and model selection. */
export function createSerialOrchestrator(deps: {
  repositories: Repositories
  modelClient: ModelClient
  taskRuns: TaskRunService
  runner: ReturnType<typeof createSingleAgentRunner>
}) {
  return {
    async run(input: { taskRunId: string; projectId: string; channelId: string; onEvent(event: StreamEvent): Promise<void> }): Promise<void> {
      const send = input.onEvent
      try {
        while (true) {
          const run = await deps.repositories.getTaskRun(input.taskRunId)
          if (!run || run.status !== 'running') return
          let turn = await deps.repositories.startNextMentionTurn(run.id, run.generation)
          if (!turn && run.turnCount === 0) turn = await deps.repositories.startSingleMemberTurn(run.id, run.generation)
          if (!turn) {
            const members = (await deps.repositories.listChannelAgents(run.channelId)).filter((item) => item.isEnabled)
            if (run.turnCount === 0 && members.length > 1) {
              await deps.repositories.pauseTaskRun(run.id, '请 CEO 指派下一位 Agent')
              await send({ taskRunId: run.id, type: 'error', content: '请 CEO 指派下一位 Agent。' })
              return
            }
            const complete = await deps.repositories.transitionTaskRun(run.id, 'running', 'completed', {})
            if (complete) await send({ taskRunId: run.id, type: 'complete' })
            return
          }
          const active = await deps.runner.resolveAgent(run.channelId, turn.agentId)
          if (!active) throw new Error('Agent 已失去发言资格')
          try { await deps.modelClient.requireCloudConsent(input.projectId, active.modelConfigId) }
          catch {
            await deps.repositories.finishAgentTurn(turn.id, 'failed')
            await deps.repositories.pauseTaskRun(run.id, 'Agent 模型未获得外发授权')
            await send({ taskRunId: run.id, type: 'error', content: 'Agent 模型未获得外发授权，等待 CEO 处理。' })
            return
          }
          const outcome = await deps.runner.run({ ...input, turnId: turn.id, generation: turn.generation, active,
            onEvent: async (event) => {
              const latest = await deps.repositories.getTaskRun(run.id)
              if (latest?.status === 'running' && latest.generation === turn.generation && latest.currentTurnId === turn.id) await send(event)
            },
          })
          if (outcome.status === 'stale') {
            const latest = await deps.repositories.getTaskRun(run.id)
            if (latest?.status === 'running' && latest.generation === turn.generation && latest.currentTurnId === turn.id) {
              await deps.repositories.finishAgentTurn(turn.id, 'failed')
              await deps.repositories.transitionTaskRun(run.id, 'running', 'failed', { errorMessage: 'Agent 配置已变化，请重新发起任务' })
              await send({ taskRunId: run.id, type: 'error', content: 'Agent 配置已变化，请重新发起任务。' })
            }
            return
          }
          if (outcome.status === 'waiting_approval') {
            await deps.repositories.markAgentTurnWaiting(turn.id, outcome.toolExecutionId)
            await send({ taskRunId: run.id, type: 'error', content: '工具操作正在等待 CEO 审批；任务已暂停，不会自动继续。' })
            return
          }
          if (outcome.status === 'failed') {
            await deps.repositories.finishAgentTurn(turn.id, 'failed')
            const failed = await deps.repositories.transitionTaskRun(run.id, 'running', 'failed', { errorMessage: outcome.reason })
            if (failed) await send({ taskRunId: run.id, type: 'error', content: outcome.reason })
            return
          }
          await deps.repositories.completeAgentTurn(turn.id, outcome.content)
        }
      } catch {
        const run = await deps.repositories.getTaskRun(input.taskRunId)
        if (run?.status !== 'running') return
        const failed = await deps.repositories.transitionTaskRun(run.id, 'running', 'failed', { errorMessage: 'Agent 任务执行失败，请重试' }).catch(() => undefined)
        if (failed) await send({ taskRunId: run.id, type: 'error', content: 'Agent 任务执行失败，请重试' })
      }
    },
  }
}
