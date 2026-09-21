import { useState } from 'react'
import type { ModelProviderPreset, SaveModelConfigInput } from '../../../shared/types'
import { Dialog } from '../common/Dialog'

export function SettingsDialog({ onSave, onClose }: { onSave(input: SaveModelConfigInput): Promise<void>; onClose(): void }) {
  const [provider, setProvider] = useState<ModelProviderPreset>('deepseek')
  const [modelName, setModelName] = useState('deepseek-chat')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <Dialog title="模型设置" onClose={onClose} busy={busy}><form onSubmit={async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    try { await onSave({ providerPreset: provider, modelName: modelName.trim(), baseUrl: baseUrl.trim(), apiKey }); setApiKey(''); onClose() }
    catch { setError('模型配置保存失败，请检查字段与本机加密服务后重试') }
    finally { setBusy(false) }
  }}><label>模型服务商<select value={provider} disabled={busy} onChange={(event) => {
    const preset = event.target.value as ModelProviderPreset
    setProvider(preset); setBaseUrl(preset === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'); setModelName(preset === 'deepseek' ? 'deepseek-chat' : '')
  }}><option value="deepseek">DeepSeek</option><option value="openai">OpenAI 兼容 API</option></select></label><label>服务地址<input type="url" required value={baseUrl} disabled={busy} onChange={(event) => setBaseUrl(event.target.value)} /></label><label>模型名称<input required value={modelName} disabled={busy} onChange={(event) => setModelName(event.target.value)} /></label><label>API Key<input type="password" required autoComplete="off" value={apiKey} disabled={busy} onChange={(event) => setApiKey(event.target.value)} /></label><p className="form-note">密钥由桌面主进程加密保存，并用于向所填服务地址认证。已有密钥不会回显。每次保存会创建新的模型配置。</p>{error && <p role="alert" className="error-card">{error}</p>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !modelName.trim() || !apiKey || !baseUrl.trim()} type="submit">{busy ? '正在保存…' : '保存配置'}</button></div></form></Dialog>
}
