import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Conversation } from '../../stores/workbench-store'
import type { ModelConfigSummary } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'
import { MarkdownMessage } from './MarkdownMessage'

const statusLabels = { queued: '排队中', running: '正在生成', cancelling: '正在停止', completed: '已完成', cancelled: '已取消', failed: '生成失败', paused: '任务已暂停，应用重启后不会自动续跑' }
export function MessageStream({ conversation, models = [] }: { conversation: Conversation; models?: ModelConfigSummary[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string, number>())
  const follow = useRef(true)
  const anchor = useRef<{ id: string; index: number; offset: number } | null>(null)
  const [measurement, setMeasurement] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const rows = useMemo(() => [
    ...[...conversation.messages, ...conversation.previews].map((message) => ({ id: `message:${message.id}`, time: message.createdAt, estimate: Math.max(84, Math.min(1200, 84 + Math.ceil(message.content.length / 70) * 24)), content: () => <article className={`message message-${message.role}`} data-agent-id={message.agentId ?? ''}><span className={`avatar ${message.role === 'ceo' ? 'ceo-avatar' : 'agent-avatar'}`} aria-hidden="true">{message.role === 'ceo' ? '♛' : conversation.agents.find((agent) => agent.id === message.agentId)?.avatar || message.authorName.slice(0, 1)}</span><div className="message-body"><div className="message-meta"><strong>{message.role === 'ceo' ? '主理人（你）' : message.authorName}</strong><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>{message.status === 'streaming' && <small>正在生成</small>}{message.status === 'completed' && message.actualModelConfigId && <small className="model-provenance">实际完成模型配置：{message.actualModelConfigId}{models.some((model) => model.id === message.actualModelConfigId) && `（当前名称：${models.find((model) => model.id === message.actualModelConfigId)?.modelName}）`}</small>}</div><div className={`message-bubble${message.role === 'agent' ? ' message-markdown' : ''}`}>{message.content ? message.role === 'agent' ? <MarkdownMessage content={message.content} /> : message.content : (message.status === 'streaming' ? '正在等待模型响应…' : '未收到回复内容')}</div></div></article> })),
    ...conversation.events.filter((event) => ['model_attempt', 'model_switched'].includes(event.eventType) && event.displayReason).map((event) => ({ id: `event:${event.id}`, time: event.createdAt, estimate: 36, content: () => <p className="model-attempt">{event.displayReason}（尝试记录，非完成结果）</p> })),
    ...conversation.runs.map((run) => ({ id: `run:${run.id}`, time: run.createdAt, estimate: 55, content: () => <div className={`run-status status-${run.status}`}><span>{statusLabels[run.status]}{run.status === 'failed' ? ` · ${run.errorMessage ?? '请检查模型配置后重试'}` : ''}</span>{run.pauseReason && <p>{run.pauseReason}</p>}</div> })),
    ...(conversation.error ? [{ id: 'error', time: '\uffff', estimate: 55, content: () => <div className="error-card" role="alert">{conversation.error}</div> }] : []),
  ].sort((a, b) => a.time.localeCompare(b.time)), [conversation.messages, conversation.previews, conversation.events, conversation.runs, conversation.error, conversation.agents, models])
  const offsets = useMemo(() => {
    const result = [0]
    for (const row of rows) result.push(result.at(-1)! + (heights.current.get(row.id) ?? row.estimate))
    return result
  }, [rows, measurement])
  const firstAt = (position: number) => {
    let low = 0, high = rows.length
    while (low < high) { const middle = (low + high) >>> 1; if (offsets[middle + 1] <= position) low = middle + 1; else high = middle }
    return Math.min(low, Math.max(0, rows.length - 1))
  }
  const start = Math.max(0, firstAt(viewport.top) - 6)
  const end = Math.min(rows.length, start + 80, firstAt(viewport.top + viewport.height) + 7)
  const readViewport = () => {
    const element = ref.current
    if (!element) return
    const inset = parseFloat(getComputedStyle(element).paddingTop) || 0
    const top = element.scrollTop - inset
    const height = element.clientHeight || 600
    setViewport((current) => current.top === top && current.height === height ? current : { top, height })
    return top
  }
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const inset = parseFloat(getComputedStyle(element).paddingTop) || 0
    if (follow.current) element.scrollTop = element.scrollHeight
    else if (anchor.current) {
      const current = anchor.current
      const index = rows.findIndex((row) => row.id === current.id)
      element.scrollTop = inset + offsets[index === -1 ? Math.min(current.index, rows.length) : index] + current.offset
    }
    readViewport()
  }, [rows, offsets, viewport.height])
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    let disposed = false
    const measure = () => {
      if (disposed) return
      let changed = false
      for (const row of element.querySelectorAll<HTMLElement>('[data-history-row]')) {
        const id = row.dataset.historyRow!
        const height = row.getBoundingClientRect().height
        if (height > 0 && Math.abs((heights.current.get(id) ?? 0) - height) > .5) { heights.current.set(id, height); changed = true }
      }
      if (changed) setMeasurement((current) => current + 1)
      readViewport()
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    for (const row of element.querySelectorAll('[data-history-row]')) observer?.observe(row)
    return () => { disposed = true; observer?.disconnect() }
  }, [rows, start, end])
  const jump = (bottom: boolean) => {
    const element = ref.current
    if (!element) return
    follow.current = bottom
    if (!bottom && rows.length) anchor.current = { id: rows[0].id, index: 0, offset: -(parseFloat(getComputedStyle(element).paddingTop) || 0) }
    element.scrollTop = bottom ? element.scrollHeight : 0
    readViewport()
  }
  return <><div className="history-navigation"><span>会话记录 · {conversation.messages.length} 条消息</span><button className="text-button" onClick={() => jump(false)}>最早记录</button><button className="text-button" onClick={() => jump(true)}>最新记录</button></div><div ref={ref} className="message-stream virtual-message-stream" role="log" aria-label="群聊消息" tabIndex={0} aria-live={follow.current ? 'polite' : 'off'} aria-relevant="additions text" onScroll={() => {
    const element = ref.current!
    follow.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80
    const top = readViewport() ?? 0
    const index = firstAt(top)
    if (rows[index]) anchor.current = { id: rows[index].id, index, offset: top - offsets[index] }
  }}>
    {conversation.loading ? <p className="loading-state">正在读取群聊记录…</p> : conversation.messages.length === 0 && conversation.previews.length === 0 && <EmptyState title="从一个具体问题开始">在下方输入你的目标，与所选模型一起讨论、整理和完善想法。</EmptyState>}
    <div aria-hidden="true" style={{ height: offsets[start] }} />
    {rows.slice(start, end).map((row, index) => <div className="history-row" role="group" data-history-row={row.id} key={row.id} aria-label={`第 ${start + index + 1} 条记录，共 ${rows.length} 条`}>{row.content()}</div>)}
    <div aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[end] }} />
  </div></>
}
