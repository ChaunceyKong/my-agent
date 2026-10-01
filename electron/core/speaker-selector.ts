import type { Agent, ChannelAgent } from '../../shared/types'

export interface SpeakerDecision { nextSpeaker: string | null; reason: string }

export function parseSpeakerDecision(raw: string, members: ChannelAgent[], agents: Agent[]): SpeakerDecision {
  if (Buffer.byteLength(raw, 'utf8') > 2048) throw new Error('调度结果过长')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('调度结果不是有效 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('调度结果格式无效')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'nextSpeaker,reason' || typeof record.reason !== 'string'
    || !record.reason.trim() || record.reason.length > 200
    || (record.nextSpeaker !== null && typeof record.nextSpeaker !== 'string')) throw new Error('调度结果格式无效')
  if (record.nextSpeaker !== null && !members.some((member) => member.isEnabled && member.agentId === record.nextSpeaker && agents.some((agent) => agent.id === member.agentId))) throw new Error('调度 Agent 不可用')
  const reason = record.reason.replace(/\s+/gu, ' ').trim()
  if (!reason || /[\p{Cc}\p{Cf}]/u.test(reason)) throw new Error('调度理由包含不可显示字符')
  return { nextSpeaker: record.nextSpeaker as string | null, reason }
}

export function speakerSelectionPrompt(members: ChannelAgent[], agents: Agent[], latestMessage: string): string {
  if (members.length > 100) throw new Error('调度成员过多')
  const roster = members.filter((member) => member.isEnabled).map((member) => {
    const agent = agents.find((item) => item.id === member.agentId)
    return agent && { id: agent.id, name: agent.name.slice(0, 80), title: agent.title.slice(0, 120) }
  }).filter(Boolean)
  const input = latestMessage.slice(0, 3000)
  const prompt = JSON.stringify({ members: roster, latestCompletedMessage: input })
  if (Buffer.byteLength(prompt, 'utf8') > 12_000) throw new Error('调度上下文过长')
  return prompt
}
