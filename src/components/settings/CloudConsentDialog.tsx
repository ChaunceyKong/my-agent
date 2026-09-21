import { useState } from 'react'
import type { ModelConfigSummary, Project } from '../../../shared/types'
import { Dialog } from '../common/Dialog'

export function CloudConsentDialog({ project, model, busy, onConfirm, onClose }: { project: Project; model: ModelConfigSummary; busy: boolean; onConfirm(): Promise<void>; onClose(): void }) {
  const [error, setError] = useState('')
  return <Dialog title="云端模型授权" onClose={onClose} busy={busy}><p>发送后，本群聊的消息内容与对话历史将传输给以下模型服务。项目目录中的文件不会被读取或上传。</p><dl className="consent-details"><dt>项目</dt><dd>{project.name}</dd><dt>模型</dt><dd>{model.modelName}</dd><dt>接收地址</dt><dd className="path-text">{model.baseUrl}</dd></dl><p className="form-note">授权适用于此项目与此模型配置的后续对话。更换项目或新建模型配置需要再次确认。</p>{error && <div role="alert" className="error-card">{error}</div>}<div className="dialog-actions"><button disabled={busy} onClick={onClose}>暂不发送</button><button className="primary-button" disabled={busy} onClick={async () => { setError(''); try { await onConfirm() } catch { setError('授权保存失败，请重试') } }}>{busy ? '正在授权…' : '同意并发送'}</button></div></Dialog>
}
