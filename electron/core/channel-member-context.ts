import type { Repositories } from '../database/repositories'

export function formatChannelMemberReply(context: Awaited<ReturnType<typeof readChannelMemberContext>>): string {
  const cell = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]()#+.!|<>@]/g, '\\$&')
  return `### 当前群聊 Agent\n\n共有 **${context.total} 位 Agent**，其中 **${context.enabledCount} 位已启用**。\n\n`
    + (context.members.length ? '| 成员 | 角色 | 状态 |\n| --- | --- | --- |\n'
      + context.members.map((member) => `| ${cell(member.name)} | ${cell(member.title) || '未填写'} | ${member.isEnabled ? '已启用' : '已停用'} |`).join('\n') + '\n\n' : '')
    + '> 数据来源：应用当前群聊成员记录。主理人（CEO）单独计算；启用状态不代表在线状态。'
}

export async function readChannelMemberContext(repositories: Pick<Repositories, 'listChannelAgents' | 'getAgent'>, channelId: string) {
  const memberships = await repositories.listChannelAgents(channelId)
  const members = await Promise.all(memberships.map(async (member) => {
    const agent = await repositories.getAgent(member.agentId)
    if (!agent) throw new Error('群聊成员状态无效')
    return { agentId: agent.id, name: agent.name, title: agent.title, isEnabled: member.isEnabled }
  }))
  return { scope: 'current_channel', channelId, total: members.length, enabledCount: members.filter((member) => member.isEnabled).length, members }
}
