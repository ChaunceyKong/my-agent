import { expect, it, vi } from 'vitest'
import { readChannelMemberContext } from '../../electron/core/channel-member-context'
import type { Repositories } from '../../electron/database/repositories'

it('reads only the selected group roster, counts disabled Agents and excludes private configuration', async () => {
  const agents = [
    { id: 'a', name: '作者', title: '写作', systemPrompt: 'PRIVATE_PROMPT', modelConfigId: 'PRIVATE_MODEL' },
    { id: 'b', name: '审核', title: '校对', systemPrompt: 'OTHER_PRIVATE_PROMPT', defaultToolPermissions: { run_process: true } },
    { id: 'other', name: '其他项目成员', title: '不相关' },
  ]
  const repositories = {
    listChannelAgents: vi.fn().mockResolvedValue([{ agentId: 'a', isEnabled: true }, { agentId: 'b', isEnabled: false }]),
    getAgent: vi.fn(async (id: string) => agents.find((agent) => agent.id === id)),
  }
  const context = await readChannelMemberContext(repositories as unknown as Repositories, 'selected')
  expect(repositories.listChannelAgents).toHaveBeenCalledWith('selected')
  expect(repositories.getAgent.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  expect(context).toEqual({ scope: 'current_channel', channelId: 'selected', total: 2, enabledCount: 1, members: [
    { agentId: 'a', name: '作者', title: '写作', isEnabled: true },
    { agentId: 'b', name: '审核', title: '校对', isEnabled: false },
  ] })
  expect(JSON.stringify(context)).not.toMatch(/PRIVATE|其他项目|run_process/)
})

it('reads current membership anew for the next request and supports an empty group', async () => {
  const repositories = { listChannelAgents: vi.fn().mockResolvedValueOnce([{ agentId: 'a', isEnabled: false }]).mockResolvedValueOnce([]), getAgent: vi.fn().mockResolvedValue({ id: 'a', name: '已停用作者', title: '写作' }) }
  expect(await readChannelMemberContext(repositories as unknown as Repositories, 'c')).toMatchObject({ total: 1, enabledCount: 0 })
  expect(await readChannelMemberContext(repositories as unknown as Repositories, 'c')).toEqual({ scope: 'current_channel', channelId: 'c', total: 0, enabledCount: 0, members: [] })
})

it('fails instead of inventing a missing member identity', async () => {
  const repositories = { listChannelAgents: vi.fn().mockResolvedValue([{ agentId: 'missing', isEnabled: true }]), getAgent: vi.fn().mockResolvedValue(undefined) }
  await expect(readChannelMemberContext(repositories as unknown as Repositories, 'c')).rejects.toThrow('群聊成员状态无效')
})
