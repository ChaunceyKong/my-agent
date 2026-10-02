import { useState } from 'react'
import type { ModelConfigSummary, ProjectSummary } from '../../../shared/types'
import { Dialog } from '../common/Dialog'

export function CloudConsentDialog({ project, model, purposes, busy, onConfirm, onClose }: { project: ProjectSummary; model: ModelConfigSummary; purposes: string[]; busy: boolean; onConfirm(): Promise<void>; onClose(): void }) {
  const [error, setError] = useState('')
  const [toolScope, setToolScope] = useState(false)
  // This dialog is keyed by configuration in App, so each candidate starts unchecked.
  return <Dialog title="云端模型授权" onClose={onClose} busy={busy}><p>本项目将向以下模型配置发送这些内容类别。授权适用于此项目和此配置；修改配置后需要重新授权。每个 Agent、调度和摘要模型及其备选配置分别核验。备选模型不会继承主模型授权；所有候选确认后才发送，关闭任一授权会取消本次操作。</p><dl className="consent-details"><dt>项目</dt><dd>{project.name}</dd><dt>模型</dt><dd>{model.modelName}</dd><dt>服务商</dt><dd>{model.providerPreset}</dd><dt>接收地址</dt><dd className="path-text">{model.baseUrl}</dd></dl><ul className="consent-categories" aria-label="外发内容类别">{purposes.map((purpose) => <li key={purpose}>{purpose}</li>)}</ul><p>工具结果仅在授权工具调用后，经脱敏和预算限制提供；不会自动上传整个项目目录。摘要与调度调用复用同一配置的项目授权。</p><label className="form-note"><input type="checkbox" checked={toolScope} onChange={(event) => setToolScope(event.target.checked)} /> 我了解以上对话、调度、摘要和 Agent 工具结果可能发送给此云端模型。</label>{error && <div role="alert" className="error-card">{error}</div>}<div className="dialog-actions"><button disabled={busy} onClick={onClose}>暂不发送</button><button className="primary-button" disabled={busy || !toolScope} onClick={async () => { setError(''); try { await onConfirm() } catch { setError('授权保存失败，请重试') } }}>{busy ? '正在授权…' : '同意并发送'}</button></div></Dialog>
}
