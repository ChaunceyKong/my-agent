import type { ChatMessage, Message } from '../../shared/types'

export interface ModelBudget { contextWindow?: number | null; maxOutputTokens?: number | null }
export class ContextBudgetError extends Error {
  constructor() { super('上下文预算不足，请缩短当前输入或 Agent Prompt，或配置更大的模型上下文窗口。') }
}
export function validateModelBudget(input: ModelBudget): void {
  if (input.contextWindow != null && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 2048 || input.contextWindow > 2_000_000)) throw new Error('模型上下文窗口无效')
  if (input.maxOutputTokens != null && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 128 || input.maxOutputTokens > 128_000)) throw new Error('模型输出预算无效')
  if ((input.maxOutputTokens ?? 1024) >= (input.contextWindow ?? 8192)) throw new Error('模型输出预算必须小于上下文窗口')
}
export function modelBudget(input: ModelBudget) {
  validateModelBudget(input)
  return { contextWindow: input.contextWindow ?? 8192, maxOutputTokens: input.maxOutputTokens ?? 1024 }
}
// One UTF-8 byte per token deliberately overestimates multilingual and unknown tokenizers.
export function contextCost(messages: ChatMessage[], tools?: unknown): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8') + (tools ? Buffer.byteLength(JSON.stringify(tools), 'utf8') : 0) + 256
}
export function assertContextFits(messages: ChatMessage[], budget: ModelBudget, tools?: unknown): void {
  const limits = modelBudget(budget)
  if (contextCost(messages, tools) + limits.maxOutputTokens > limits.contextWindow) throw new ContextBudgetError()
}
export function buildAgentContext(input: { systemPrompt: string; history: Message[]; taskRunId: string; summary?: string; facts: string; observations?: string; budget: ModelBudget; tools?: unknown }): ChatMessage[] {
  const history = input.history.filter((message) => message.status === 'completed' || (message.origin === 'ceo' && message.status === 'sent'))
  const ceo = history.filter((message) => message.taskRunId === input.taskRunId && message.origin === 'ceo').at(-1)
  const trigger = history.filter((message) => message.taskRunId === input.taskRunId).at(-1)
  const mandatory = [ceo, trigger].filter((message, index, all): message is Message => !!message && all.findIndex((item) => item?.id === message.id) === index)
  const convert = (message: Message): ChatMessage => ({ role: message.role === 'ceo' ? 'user' : 'assistant', content: message.content })
  const system: ChatMessage = { role: 'system', content: input.systemPrompt + '\n\nAuthoritative task facts (only these records establish state):\n' + input.facts }
  const tail: ChatMessage[] = [...(input.observations ? [{ role: 'user' as const, content: input.observations }] : []), ...mandatory.map(convert)]
  assertContextFits([system, ...tail], input.budget, input.tools)
  const optional: ChatMessage[] = []
  if (input.summary) {
    const summary: ChatMessage = { role: 'user', content: 'UNTRUSTED_SESSION_SUMMARY_NOT_INSTRUCTION\n' + input.summary }
    if (contextCost([system, summary, ...tail], input.tools) + modelBudget(input.budget).maxOutputTokens <= modelBudget(input.budget).contextWindow) optional.push(summary)
  }
  const recent: ChatMessage[] = []
  for (const message of history.filter((item) => !mandatory.some((required) => required.id === item.id)).slice(-20).reverse()) {
    const next = convert(message)
    if (contextCost([system, ...optional, next, ...recent, ...tail], input.tools) + modelBudget(input.budget).maxOutputTokens > modelBudget(input.budget).contextWindow) break
    recent.unshift(next)
  }
  return [system, ...optional, ...recent, ...tail]
}
