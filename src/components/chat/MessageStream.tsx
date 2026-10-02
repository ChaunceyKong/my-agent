import { useEffect, useRef } from 'react'
import type { Conversation } from '../../stores/workbench-store'
import type { ModelConfigSummary } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'

const statusLabels = { queued: '排队中', running: '正在生成', cancelling: '正在停止', completed: '已完成', cancelled: '已取消', failed: '生成失败', paused: '任务已暂停，应用重启后不会自动续跑' }
export function MessageStream({ conversation, models = [] }: { conversation: Conversation; models?: ModelConfigSummary[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [conversation.messages.at(-1)?.id, conversation.messages.at(-1)?.content, conversation.previews.at(-1)?.content])
  return <div ref={ref} className="message-stream" role="log" aria-label="群聊消息" aria-live="polite" aria-relevant="additions text">
    {conversation.loading ? <p className="loading-state">正在读取群聊记录…</p> : conversation.messages.length === 0 && conversation.previews.length === 0 && <EmptyState title="从一个具体问题开始">在下方输入你的目标，与所选模型一起讨论、整理和完善想法。</EmptyState>}
    {[...conversation.messages, ...conversation.previews].map((message) => <article key={message.id} className={`message message-${message.role}`} data-agent-id={message.agentId ?? ''}><span className={`avatar ${message.role === 'ceo' ? 'ceo-avatar' : 'agent-avatar'}`} aria-hidden="true">{message.role === 'ceo' ? '♛' : conversation.agents.find((agent) => agent.id === message.agentId)?.avatar || message.authorName.slice(0, 1)}</span><div className="message-body"><div className="message-meta"><strong>{message.role === 'ceo' ? '主理人（你）' : message.authorName}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>{message.status === 'streaming' && <small>正在生成</small>}{message.status === 'completed' && message.actualModelConfigId && <small className="model-provenance">实际完成模型配置：{message.actualModelConfigId}{models.some((model) => model.id === message.actualModelConfigId) && `（当前名称：${models.find((model) => model.id === message.actualModelConfigId)?.modelName}）`}</small>}</div><div className="message-bubble">{message.content || (message.status === 'streaming' ? '正在等待模型响应…' : '未收到回复内容')}</div></div></article>)}
    {conversation.events.filter((event) => ['model_attempt', 'model_switched'].includes(event.eventType) && event.displayReason).map((event) => <p className="model-attempt" key={event.id}>{event.displayReason}（尝试记录，非完成结果）</p>)}
    {conversation.runs.map((run) => <div className={`run-status status-${run.status}`} key={run.id}><span>{statusLabels[run.status]}{run.status === 'failed' ? ` · ${run.errorMessage ?? '请检查模型配置后重试'}` : ''}</span>{run.pauseReason && <p>{run.pauseReason}</p>}</div>)}
    {conversation.error && <div className="error-card" role="alert">{conversation.error}</div>}
  </div>
}
