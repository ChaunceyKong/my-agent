import { expect, it } from 'vitest'
import { isChannelRosterQuery } from '../../shared/channel-roster-query'

it.each(['当前群聊有多少位 Agent？请列出名单和启用状态。', '项目群聊中加入的agent成员有哪些？', '群里有几个人？', '当前群聊都有谁', '请查询当前群聊成员信息', '更新后的群聊成员有几位？'])('recognizes a roster-only question: %s', (question) => {
  expect(isChannelRosterQuery(question)).toBe(true)
})
it.each(['帮群聊成员写一篇文章', '列出成员名单并执行程序', '当前群聊有多少位Agent，顺便帮我安排发布计划', '其他项目有多少个 Agent', '每个 Agent 应该有哪些技能', '删除群聊成员', '如何添加Agent？'])('preserves a task or other-scope question for the model: %s', (question) => {
  expect(isChannelRosterQuery(question)).toBe(false)
})
it('ignores only the validated mention ranges, never text pretending to be a mention', () => {
  const token = { agentId: 'a', start: 0, end: 3, text: '@主编' }
  expect(isChannelRosterQuery('@主编 当前群聊成员有哪些？', [token])).toBe(true)
  expect(isChannelRosterQuery('@其他 当前群聊成员有哪些？', [token])).toBe(false)
})
