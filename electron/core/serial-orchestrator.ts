import type { StreamEvent } from '../../shared/types'
import type { Repositories } from '../database/repositories'
import type { ModelClient } from './model-client'
import type { createSingleAgentRunner } from './single-agent-runner'
import type { TaskRunService } from './task-run-service'
import { parseSpeakerDecision, speakerSelectionPrompt } from './speaker-selector'
import { createSessionSummaryService } from './session-summary-service'

export function loopPauseReason(speakers: string[]): string | undefined {
  const last = speakers.slice(-3)
  if (last.length === 3 && last.every((id) => id === last[0])) return '同一 Agent 连续发言 3 轮，等待 CEO 处理'
  const cycle = speakers.slice(-12)
  if (cycle.length === 12 && cycle[0] !== cycle[1] && cycle.every((id, index) => id === cycle[index % 2])) return 'Agent 交替循环达到 3 次，等待 CEO 处理'
}

/** One durable Turn at a time; every model decision is rechecked at commit. */
export function createSerialOrchestrator(deps: {
  repositories: Repositories
  modelClient: ModelClient
  taskRuns: TaskRunService
  runner: ReturnType<typeof createSingleAgentRunner>
}) {
  const summarize = createSessionSummaryService(deps.repositories, deps.modelClient)
  return {
    async run(input: { taskRunId: string; projectId: string; channelId: string; onEvent(event: StreamEvent): Promise<void> }): Promise<void> {
      const send = input.onEvent
      const generation = (await deps.repositories.getTaskRun(input.taskRunId))?.generation
      try {
        while (true) {
          const run = await deps.repositories.getTaskRun(input.taskRunId)
          if (!run || run.status !== 'running' || run.generation !== generation) return
          const channel = await deps.repositories.getChannel(run.channelId)
          if (!channel) throw new Error('群聊不存在')
          if (channel.id !== input.channelId || channel.projectId !== input.projectId) throw new Error('任务归属不一致')
          const turns = await deps.repositories.listAgentTurns(run.id)
          const loopReason = loopPauseReason(turns.filter((item) => item.generation === run.generation && item.status === 'completed').map((item) => item.agentId))
          if (!run.currentTurnId && (run.turnCount >= channel.maxTurns || loopReason)) {
            const reason = loopReason ?? 'Agent 轮次已达到群聊上限'
            await deps.repositories.pauseTaskRun(run.id, reason)
            await send({ taskRunId: run.id, type: 'error', content: reason })
            return
          }
          let turn = run.currentTurnId ? turns.find((item) => item.id === run.currentTurnId && item.status === 'running' && item.generation === run.generation)
            : await deps.repositories.startNextMentionTurn(run.id, run.generation)
          if (run.currentTurnId && !turn) return
          if (!turn && run.turnCount === 0) turn = await deps.repositories.startSingleMemberTurn(run.id, run.generation)
          if (!turn) {
            const members = (await deps.repositories.listChannelAgents(run.channelId)).filter((item) => item.isEnabled)
            const scheduler = await deps.repositories.getEffectiveScheduler(run.channelId)
            if (members.length > 1 && channel.speakerMode === 'automatic' && scheduler) {
              const agents = await deps.repositories.listAgents()
              const memberRevisions = Object.fromEntries(members.map((member) => [member.agentId, member.revision]))
              const current = async () => {
                const latest = await deps.repositories.getTaskRun(run.id)
                const currentChannel = await deps.repositories.getChannel(run.channelId)
                const currentMembers = (await deps.repositories.listChannelAgents(run.channelId)).filter((member) => member.isEnabled)
                return latest?.status === 'running' && latest.generation === run.generation && !latest.currentTurnId
                  && await deps.repositories.getEffectiveScheduler(run.channelId) === scheduler && currentChannel?.speakerMode === 'automatic'
                  && currentMembers.length === members.length && currentMembers.every((member) => memberRevisions[member.agentId] === member.revision)
              }
              try {
                const messages = (await deps.repositories.listMessages(run.channelId)).filter((message) => message.taskRunId === run.id && message.status === 'completed')
                const raw = await deps.modelClient.selectSpeaker({ projectId: input.projectId, modelConfigId: scheduler,
                  taskRunId: run.id, prompt: speakerSelectionPrompt(members, agents, messages.at(-1)?.content ?? '') }, current)
                const decision = parseSpeakerDecision(raw, members, agents)
                turn = await deps.repositories.commitSpeakerDecision({ taskRunId: run.id, generation: run.generation,
                  modelConfigId: scheduler, memberRevisions, ...decision }) ?? undefined
                if (!turn) { await send({ taskRunId: run.id, type: 'complete' }); return }
              } catch {
                const latest = await deps.repositories.getTaskRun(run.id)
                if (latest?.status !== 'running' || latest.generation !== run.generation || latest.currentTurnId) return
                await deps.repositories.pauseTaskRun(run.id, '自动调度不可用，请 CEO 指派下一位 Agent')
                await send({ taskRunId: run.id, type: 'error', content: '自动调度不可用，请 CEO 指派下一位 Agent。' })
                return
              }
            } else if (members.length > 1) {
              await deps.repositories.pauseTaskRun(run.id, '请 CEO 指派下一位 Agent 或配置调度模型')
              await send({ taskRunId: run.id, type: 'error', content: '请 CEO 指派下一位 Agent 或配置调度模型。' })
              return
            } else {
              const complete = await deps.repositories.transitionTaskRun(run.id, 'running', 'completed', {})
              if (complete) await send({ taskRunId: run.id, type: 'complete' })
              return
            }
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
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<{ status: 'paused'; reason: string }>((resolve) => {
            timer = setTimeout(() => resolve({ status: 'paused', reason: 'Agent 调用超过 120 秒，等待 CEO 处理' }), 120_000)
          })
          const outcome = await Promise.race([deps.runner.run({ ...input, turnId: turn.id, generation: turn.generation, active,
            onEvent: async (event) => {
              const latest = await deps.repositories.getTaskRun(run.id)
              if (latest?.status === 'running' && latest.generation === turn.generation && latest.currentTurnId === turn.id) await send(event)
            },
          }), timeout]).finally(() => clearTimeout(timer))
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
          if (outcome.status === 'paused') {
            await deps.taskRuns.pauseTaskRun(run.id, outcome.reason, turn.generation)
            await send({ taskRunId: run.id, type: 'error', content: outcome.reason })
            return
          }
          await deps.repositories.completeAgentTurn(turn.id, outcome.content)
          await summarize(run.id)
        }
      } catch {
        const run = await deps.repositories.getTaskRun(input.taskRunId)
        if (run?.status !== 'running' || run.generation !== generation) return
        const failed = await deps.repositories.transitionTaskRun(run.id, 'running', 'failed', { errorMessage: 'Agent 任务执行失败，请重试' }).catch(() => undefined)
        if (failed) await send({ taskRunId: run.id, type: 'error', content: 'Agent 任务执行失败，请重试' })
      }
    },
  }
}
