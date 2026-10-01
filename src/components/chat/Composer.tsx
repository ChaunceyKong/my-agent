import { useRef } from 'react'
import type { AgentSummary, CeoMentionToken, ModelConfigSummary } from '../../../shared/types'

interface Props {
  draft: string; models: ModelConfigSummary[]; modelId: string; disabled: boolean; sending: boolean; running: boolean
  blocked: boolean; cancelling: boolean; members: AgentSummary[]; mentions: CeoMentionToken[]
  onMention(agentId: string, start: number, end: number): void; onInterrupt(): void
  onDraft(value: string): void; onModel(id: string): void; onSend(): void; onCancel(): void; onSettings(): void
}
export function Composer(props: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); props.onSend() }}>
    {!!props.members.length && <div className="mention-toolbar"><label htmlFor="mention-member">@ 指派成员</label><select id="mention-member" value="" disabled={props.disabled || props.sending || props.cancelling} onChange={(event) => {
      const start = textarea.current?.selectionStart ?? props.draft.length
      const end = textarea.current?.selectionEnd ?? start
      props.onMention(event.target.value, start, end); textarea.current?.focus()
    }}><option value="">选择发言成员</option>{props.members.map((agent) => <option key={agent.id} value={agent.id} disabled={props.mentions.some((token) => token.agentId === agent.id)}>{agent.name}</option>)}</select></div>}
    {!!props.mentions.length && <ol className="mention-chips" aria-label="指派顺序">{props.mentions.map((token, index) => <li key={token.agentId}>{index + 1}. {token.text}</li>)}</ol>}
    <label className="sr-only" htmlFor="message-content">消息内容</label><textarea ref={textarea} id="message-content" value={props.draft} disabled={props.disabled || props.sending || props.cancelling} placeholder="描述你的目标，可通过上方 @ 选择成员…" onChange={(event) => props.onDraft(event.target.value)} onKeyDown={(event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !props.running && !props.sending) { event.preventDefault(); props.onSend() }
  }} /><div className="composer-toolbar"><div className="model-picker"><label className="sr-only" htmlFor="model-select">对话模型</label><select id="model-select" value={props.modelId} disabled={props.sending || props.blocked} onChange={(event) => props.onModel(event.target.value)}><option value="" disabled>请选择模型</option>{props.models.map((model) => <option value={model.id} key={model.id}>{model.modelName}</option>)}</select>{!props.models.length && <button type="button" className="text-button" onClick={props.onSettings}>配置模型</button>}</div><div className="composer-actions">{props.running && <><button type="button" disabled={props.sending || !props.draft.trim()} onClick={props.onInterrupt}>中断并发送新指令</button><button type="button" className="stop-button" disabled={props.sending} onClick={props.onCancel}>停止生成</button></>}{!props.running && <button className="primary-button" type="submit" disabled={props.disabled || props.sending || props.blocked || !props.draft.trim() || !props.modelId}>{props.sending ? '正在处理…' : props.cancelling ? '正在安全停止…' : '发送消息'}</button>}</div></div><p className="composer-hint">Enter 发送 · Shift + Enter 换行 · @ 选择器生成指派，手输姓名仅作为消息文本</p>{props.blocked && !props.running && <p className="composer-hint">当前任务需先继续或结束，才能发送新任务。</p>}</form>
}
