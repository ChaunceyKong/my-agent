import type { CeoMentionToken } from './types'

/** Only roster questions are answered locally; mixed task requests still go to Agents. */
export function isChannelRosterQuery(content: string, mentions: CeoMentionToken[] = []): boolean {
  let question = content
  for (const token of [...mentions].sort((a, b) => b.start - a.start)) {
    if (question.slice(token.start, token.end) !== token.text) return false
    question = question.slice(0, token.start) + question.slice(token.end)
  }
  question = question.toLowerCase().replace(/[\s，。！？、：；,.!?;:]/gu, '')
  if (question.length > 160 || !/(?:agents?|智能体|成员|群聊|群里)/u.test(question)
    || !/(?:多少|几|谁|哪些|名单|列出|查询|查看|成员信息)/u.test(question)) return false
  return !question.replace(/(?:启用状态|成员信息|更新后的|当前群聊|项目群聊|群聊成员|角色分工|负责什么|多少位|多少个|有多少|有几位|有几个|有几人|有哪些|都有谁|告诉我|介绍一下|确认一下|查询一下|查看一下|列一下|显示一下|看一下|查一下|agents?|智能体|已启用|已停用|请问|能否|可以|帮我|麻烦|我想|告诉|查询|查看|列出|显示|确认|名单|成员|人数|数量|状态|职责|分工|角色|已加入|加入|现在|当前|目前|这个|项目|群聊|群组|群里|这里|所有|哪些|是谁|有谁|多少|以及|其中|是否|和|与|及|中|内|的|都|有|几|谁|人|位|个|请|吗|呢)/gu, '')
}
