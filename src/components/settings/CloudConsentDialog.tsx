import { useState } from 'react'
import type { ModelConfigSummary, ProjectSummary } from '../../../shared/types'
import { Dialog } from '../common/Dialog'

export function CloudConsentDialog({ project, model, busy, onConfirm, onClose }: { project: ProjectSummary; model: ModelConfigSummary; busy: boolean; onConfirm(): Promise<void>; onClose(): void }) {
  const [error, setError] = useState('')
  const [toolScope, setToolScope] = useState(false)
  return <Dialog title="云端模型授权" onClose={onClose} busy={busy}><p>发送后，本群聊的消息内容与对话历史将传输给以下模型服务。启用 Agent 工具后，仅当你请求读取或搜索时，受限、脱敏且有预算上限的结果可能作为上下文发送给该模型；不会自动上传整个项目目录。</p><dl className="consent-details"><dt>项目</dt><dd>{project.name}</dd><dt>模型</dt><dd>{model.modelName}</dd><dt>接收地址</dt><dd className="path-text">{model.baseUrl}</dd></dl><label className="form-note"><input type="checkbox" checked={toolScope} onChange={(event) => setToolScope(event.target.checked)} /> 我了解 Agent 工具结果可能发送给此云端模型。</label>{error && <div role="alert" className="error-card">{error}</div>}<div className="dialog-actions"><button disabled={busy} onClick={onClose}>暂不发送</button><button className="primary-button" disabled={busy || !toolScope} onClick={async () => { setError(''); try { await onConfirm() } catch { setError('授权保存失败，请重试') } }}>{busy ? '正在授权…' : '同意并发送'}</button></div></Dialog>
}
