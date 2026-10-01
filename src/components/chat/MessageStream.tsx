import { useEffect, useRef } from 'react'
import type { Conversation } from '../../stores/workbench-store'
import { EmptyState } from '../common/EmptyState'

const statusLabels = { queued: '排队中', running: '正在生成', cancelling: '正在停止', completed: '已完成', cancelled: '已取消', failed: '生成失败', paused: '任务已暂停，应用重启后不会自动续跑' }
export function MessageStream({ conversation }: { conversation: Conversation }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [conversation.messages, conversation.runs])
  return <div ref={ref} className="message-stream" role="log" aria-label="群聊消息" aria-live="polite" aria-relevant="additions text">
    {conversation.loading ? <p className="loading-state">正在读取群聊记录…</p> : conversation.messages.length === 0 && <EmptyState title="从一个具体问题开始">在下方输入你的目标，与所选模型一起讨论、整理和完善想法。</EmptyState>}
    {conversation.messages.map((message) => <article key={message.id} className={`message message-${message.role}`}><span className={`avatar ${message.role === 'ceo' ? 'ceo-avatar' : 'agent-avatar'}`} aria-hidden="true">{message.role === 'ceo' ? '♛' : '✦'}</span><div className="message-body"><div className="message-meta"><strong>{message.role === 'ceo' ? '主理人（你）' : 'AI 助手'}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><div className="message-bubble">{message.content || (message.status === 'streaming' ? '正在等待模型响应…' : '未收到回复内容')}</div></div></article>)}
    {conversation.runs.map((run) => <div className={`run-status status-${run.status}`} key={run.id}>{statusLabels[run.status]}{run.status === 'failed' && !conversation.error ? ` · ${run.errorMessage ?? '请检查模型配置后重试'}` : ''}</div>)}
    {conversation.error && <div className="error-card" role="alert">{conversation.error}</div>}
  </div>
}
