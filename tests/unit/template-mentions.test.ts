import { expect, it } from 'vitest'
import { parseAgentMentions } from '../../electron/core/mention-parser'
import type { Agent, ChannelAgent } from '../../shared/types'

function fixtures(names: string[]) {
  const agents: Agent[] = names.map((name, index) => ({ id: `a${index}`, name, avatar: null, title: '', systemPrompt: '',
    modelConfigId: 'm', defaultToolPermissions: {}, isBuiltin: false, createdAt: '', updatedAt: '' }))
  const members: ChannelAgent[] = agents.map((agent) => ({ channelId: 'c', agentId: agent.id, isEnabled: true,
    modelConfigOverrideId: null, toolPermissionsOverride: null, revision: 'rev', createdAt: '', updatedAt: '' }))
  return { agents, members }
}

it('recognizes exact PRD names and uniquely suffixed copies without truncating their spaces or brackets', () => {
  const { agents, members } = fixtures(['内容主编 (PM)', '商业模式架构师 (Lean Canvas)', '代码质检员 (QA)', '内容主编 (PM) 2'])
  const text = agents.map((agent) => `@${agent.name}，`).join(' ')
  expect(parseAgentMentions(text, 'another', members, agents)).toEqual(agents.map((agent) => agent.id))
})

it('matches the longest complete name, escapes regex punctuation and keeps textual order and deduplication', () => {
  const { agents, members } = fixtures(['Alpha', 'Alpha Beta', 'A+B [QA]', 'A+B [QA] 2'])
  expect(parseAgentMentions('@Alpha Beta， @A+B [QA] 2！ @Alpha @A+B [QA] @Alpha', 'another', members, agents))
    .toEqual(['a1', 'a3', 'a0', 'a2'])
  expect(parseAgentMentions('@AlphaBeta', 'another', members, agents)).toEqual([])
  // A complete short name followed by ordinary words remains a valid mention.
  expect(parseAgentMentions('@Alpha BetaMore @A+B [QA] 2More', 'another', members, agents)).toEqual(['a0', 'a2'])
})

it('retains email, prefix, duplicate-name, self and disabled membership boundaries', () => {
  const { agents, members } = fixtures(['Alpha', 'Beta', 'Same', 'Same', 'Disabled'])
  members[4].isEnabled = false
  expect(parseAgentMentions('mail@Alpha example_@Beta @Same @Disabled @Alpha @Beta', 'a0', members, agents)).toEqual(['a1'])
  expect(parseAgentMentions('@Beta', 'another', [], agents)).toEqual([])
})
