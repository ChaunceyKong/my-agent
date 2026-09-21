import type { ModelConfigSummary } from '../../../shared/types'

interface Props {
  draft: string; models: ModelConfigSummary[]; modelId: string; disabled: boolean; sending: boolean; running: boolean
  onDraft(value: string): void; onModel(id: string): void; onSend(): void; onCancel(): void; onSettings(): void
}
export function Composer(props: Props) {
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); props.onSend() }}><label className="sr-only" htmlFor="message-content">消息内容</label><textarea id="message-content" value={props.draft} disabled={props.disabled || props.sending} placeholder="描述你的目标、问题或需要一起完善的内容…" onChange={(event) => props.onDraft(event.target.value)} onKeyDown={(event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !props.running && !props.sending) { event.preventDefault(); props.onSend() }
  }} /><div className="composer-toolbar"><div className="model-picker"><label className="sr-only" htmlFor="model-select">对话模型</label><select id="model-select" value={props.modelId} disabled={props.sending || props.running} onChange={(event) => props.onModel(event.target.value)}><option value="" disabled>请选择模型</option>{props.models.map((model) => <option value={model.id} key={model.id}>{model.modelName}</option>)}</select>{!props.models.length && <button type="button" className="text-button" onClick={props.onSettings}>配置模型</button>}</div>{props.running ? <button type="button" className="stop-button" onClick={props.onCancel}>停止生成</button> : <button className="primary-button" type="submit" disabled={props.disabled || props.sending || !props.draft.trim() || !props.modelId}>{props.sending ? '正在发送…' : '发送消息'}</button>}</div><p className="composer-hint">Enter 发送 · Shift + Enter 换行 · 当前版本仅支持模型对话</p></form>
}
