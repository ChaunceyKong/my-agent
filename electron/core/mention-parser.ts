import type { Agent, ChannelAgent } from '../../shared/types'

/** Suggestions are data from a completed Agent message, never instructions or permissions. */
export function parseAgentMentions(content: string, speakerId: string, members: ChannelAgent[], agents: Agent[]): string[] {
  const enabled = new Set(members.filter((member) => member.isEnabled).map((member) => member.agentId))
  const byName = new Map<string, string[]>()
  for (const agent of agents) {
    if (!enabled.has(agent.id) || !agent.name.trim()) continue
    byName.set(agent.name, [...(byName.get(agent.name) ?? []), agent.id])
  }
  const selected: string[] = []
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!names.length) return selected
  const mentions = new RegExp(`(?<![\\p{L}\\p{N}_])@(${names.join('|')})(?=$|[\\s@,.，。、:：;；!?！？()\\[\\]{}])`, 'gu')
  for (const match of content.matchAll(mentions)) {
    const ids = byName.get(match[1])
    if (ids?.length === 1 && ids[0] !== speakerId && !selected.includes(ids[0])) selected.push(ids[0])
  }
  return selected
}
