import type { Repositories } from '../database/repositories'
import type { ModelClient } from './model-client'

/** Summaries cover a completed prefix only; they are never a source of state or routing. */
export function createSessionSummaryService(repositories: Repositories, modelClient: ModelClient) {
  return async (taskRunId: string): Promise<void> => {
    const run = await repositories.getTaskRun(taskRunId)
    if (!run || run.status !== 'running' || run.currentTurnId) return
    const completed = (await repositories.listTaskRunEvents(run.id)).filter((event) => event.eventType === 'turn_completed')
    if (completed.length < 10) return
    const cutoff = completed[Math.floor(completed.length / 10) * 10 - 1].seq
    const previous = await repositories.getLatestSessionSummary(run.channelId)
    if (previous?.taskRunId === run.id && previous.coveredThroughSeq >= cutoff) return
    const channel = await repositories.getChannel(run.channelId)
    if (!channel) return
    const scheduler = await repositories.getEffectiveScheduler(channel.id)
    if (!scheduler) return
    const config = await repositories.getModelConfig(scheduler)
    if (!config) return
    const snapshotMembers = async () => {
      const members = (await repositories.listChannelAgents(run.channelId)).filter((member) => member.isEnabled).sort((a, b) => a.agentId.localeCompare(b.agentId))
      return JSON.stringify(await Promise.all(members.map(async (member) => ({ member, agent: await repositories.getAgent(member.agentId) }))))
    }
    const memberSnapshot = await snapshotMembers()
    const modelSnapshot = JSON.stringify(config)
    let actualModelConfigId = config.id
    let actualModelSnapshot = modelSnapshot
    const current = async () => {
      const latest = await repositories.getTaskRun(run.id)
      const currentChannel = await repositories.getChannel(run.channelId)
      return latest?.status === 'running' && latest.generation === run.generation && !latest.currentTurnId
        && !!currentChannel && await repositories.getEffectiveScheduler(channel.id) === config.id && JSON.stringify(await repositories.getModelConfig(config.id)) === modelSnapshot
        && await snapshotMembers() === memberSnapshot && await repositories.hasCloudConsent(channel.projectId, config.id)
        && JSON.stringify(await repositories.getModelConfig(actualModelConfigId)) === actualModelSnapshot
        && await repositories.hasCloudConsent(channel.projectId, actualModelConfigId)
    }
    try {
      await modelClient.requireCloudConsent(channel.projectId, config.id)
      const history = await repositories.listSessionSummaryMessages(run.id, cutoff, previous)
      const prompt = JSON.stringify({ taskRunId: run.id, coveredThroughSeq: cutoff, previousSummary: previous?.content ?? null,
        conversation: history.map((message) => ({ taskRunId: message.taskRunId, seq: message.taskRunSeq, author: message.authorName, text: message.content })) })
      const content = await modelClient.summarizeSession({ projectId: channel.projectId, modelConfigId: config.id, taskRunId: run.id, prompt }, current, async (selection) => {
        actualModelConfigId = selection.actualModelConfigId
        actualModelSnapshot = selection.modelSnapshot
      })
      if (!await current()) return
      await repositories.saveSessionSummary({ taskRunId: run.id, generation: run.generation, coveredThroughSeq: cutoff, content,
        configuredModelConfigId: config.id, configuredModelSnapshot: modelSnapshot, modelConfigId: actualModelConfigId, modelSnapshot: actualModelSnapshot, memberSnapshot })
    } catch {
      // A failed attempt preserves the old summary. A later completed Turn retries the same prefix.
    }
  }
}
