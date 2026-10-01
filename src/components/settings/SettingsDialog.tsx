import { useEffect, useState } from 'react'
import type { ModelConfigSummary, ModelProviderPreset, SaveModelConfigInput } from '../../../shared/types'
import { Dialog } from '../common/Dialog'

export function SettingsDialog({ onSave, onClose }: { onSave(input: SaveModelConfigInput): Promise<void>; onClose(): void }) {
  const [models, setModels] = useState<ModelConfigSummary[]>([])
  const [id, setId] = useState('')
  const [provider, setProvider] = useState<ModelProviderPreset>('deepseek')
  const [modelName, setModelName] = useState('deepseek-chat')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [apiKey, setApiKey] = useState('')
  const [context, setContext] = useState('')
  const [output, setOutput] = useState('')
  const [scheduler, setScheduler] = useState('')
  const [discovered, setDiscovered] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const reload = async () => { setModels(await window.agentTeam.models.list()); setScheduler(await window.agentTeam.models.getDefaultScheduler() ?? '') }
  useEffect(() => { void reload().catch(() => setNotice('模型列表读取失败')) }, [])
  const action = async (operation: () => Promise<void>) => {
    if (busy) return; setBusy(true); setNotice('')
    try { await operation() } catch (error) { setNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '操作失败') }
    finally { setBusy(false) }
  }
  const select = (selected: string) => {
    setId(selected); setApiKey(''); setDiscovered([])
    const model = models.find((item) => item.id === selected)
    if (model) { setProvider(model.providerPreset); setModelName(model.modelName); setBaseUrl(model.baseUrl); setContext(model.contextWindow?.toString() ?? ''); setOutput(model.maxOutputTokens?.toString() ?? '') }
  }
  return <Dialog title="模型设置" onClose={onClose} busy={busy}><form onSubmit={async (event) => {
    event.preventDefault()
    await action(async () => {
      await onSave({ ...(id ? { id } : {}), providerPreset: provider, modelName: modelName.trim(), baseUrl: baseUrl.trim(), apiKey,
        contextWindow: context ? Number(context) : null, maxOutputTokens: output ? Number(output) : null })
      setApiKey(''); await reload(); setNotice('模型配置已保存')
    })
  }}><label>已有配置<select disabled={busy} value={id} onChange={(event) => select(event.target.value)}><option value="">新建模型配置</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName} · {model.providerPreset}</option>)}</select></label>
  <label>模型服务商<select value={provider} disabled={busy} onChange={(event) => {
    const preset = event.target.value as ModelProviderPreset; setProvider(preset); setDiscovered([])
    setBaseUrl(preset === 'deepseek' ? 'https://api.deepseek.com' : preset === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1'); setModelName(preset === 'deepseek' ? 'deepseek-chat' : '')
  }}><option value="deepseek">DeepSeek</option><option value="openai">OpenAI 兼容 API</option><option value="ollama">Ollama 本机模型</option></select></label>
  <label>服务地址<input type="url" required value={baseUrl} disabled={busy} onChange={(event) => setBaseUrl(event.target.value)} /></label>
  {provider === 'ollama' && <button type="button" disabled={busy} onClick={() => { void action(async () => { const names = await window.agentTeam.models.discover(baseUrl); setDiscovered(names); setNotice(names.length ? '已读取本机模型' : '未找到本机模型') }) }}>发现本机模型</button>}
  <label>模型名称<input required list="ollama-models" value={modelName} disabled={busy} onChange={(event) => setModelName(event.target.value)} /><datalist id="ollama-models">{discovered.map((name) => <option key={name} value={name} />)}</datalist></label>
  {provider !== 'ollama' && <label>API Key<input type="password" required={!id} autoComplete="off" value={apiKey} disabled={busy} onChange={(event) => setApiKey(event.target.value)} placeholder={id ? '留空保留已有密钥' : ''} /></label>}
  <label>上下文窗口<input type="number" min="1" value={context} disabled={busy} onChange={(event) => setContext(event.target.value)} placeholder="使用保守默认值" /></label>
  <label>最大输出 Token<input type="number" min="1" value={output} disabled={busy} onChange={(event) => setOutput(event.target.value)} placeholder="使用保守默认值" /></label>
  <p className="form-note">密钥加密保存在本机。修改配置后需重新确认云端外发。Ollama 仅支持本机模型。</p>
  <label>默认调度模型<select value={scheduler} disabled={busy} onChange={(event) => { const value = event.target.value; void action(async () => { await window.agentTeam.models.setDefaultScheduler(value || null); setScheduler(value) }) }}><option value="">未设置</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><p className="form-note">群聊未指定调度模型时使用此默认配置。</p>
  {notice && <p role="status" className="form-note">{notice}</p>}
  <div className="dialog-actions">{id && <><button type="button" disabled={busy} onClick={() => { void action(async () => { setNotice((await window.agentTeam.models.test(id)).message) }) }}>测试连接</button><button type="button" disabled={busy} onClick={() => { void action(async () => { await window.agentTeam.models.remove(id); setId(''); await reload(); setNotice('配置已删除') }) }}>删除配置</button></>}<button type="button" disabled={busy} onClick={onClose}>关闭</button><button className="primary-button" disabled={busy || !modelName.trim() || (!id && provider !== 'ollama' && !apiKey) || !baseUrl.trim()} type="submit">{busy ? '处理中…' : '保存配置'}</button></div></form></Dialog>
}
