import { useEffect, useRef, useState } from 'react'
import type { AgentTemplate, AgentTemplateRole, AgentTemplateSummary, Channel, ModelConfigSummary } from '../../../shared/types'
import { Dialog } from '../common/Dialog'

export function TemplateMarket({ channel, models, busy, onImport, onCopy }: {
  channel: Channel; models: ModelConfigSummary[]; busy: boolean
  onImport(templateId: string, modelConfigId: string): void
  onCopy(templateId: string, role: AgentTemplateRole, modelConfigId: string): void
}) {
  const [templates, setTemplates] = useState<AgentTemplateSummary[]>([])
  const [preview, setPreview] = useState<AgentTemplate | null>(null)
  const [modelId, setModelId] = useState(models[0]?.id ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  useEffect(() => {
    const generation = ++revision.current
    void window.agentTeam.templates.list().then((items) => { if (revision.current === generation) setTemplates(items) }).catch(() => { if (revision.current === generation) setError('模板列表读取失败') })
    return () => { revision.current++ }
  }, [channel.id])
  useEffect(() => { if (!models.some((model) => model.id === modelId)) setModelId(models[0]?.id ?? '') }, [models, modelId])
  const open = async (id: string) => {
    const generation = ++revision.current
    setLoading(true); setError('')
    try { const value = await window.agentTeam.templates.get(id); if (generation === revision.current) setPreview(value) }
    catch { if (generation === revision.current) setError('模板预览读取失败') }
    finally { if (generation === revision.current) setLoading(false) }
  }
  return <section aria-label="Agent 模板市场" className="template-market"><h3>团队模板</h3><p className="form-note">导入到「{channel.name}」。生成可编辑副本并启用成员，不启动任务。工具权限默认全部拒绝。</p>
    <label>模板导入模型<select aria-label="模板导入模型" disabled={busy || loading} value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">请选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label>
    {error && <p role="alert" className="error-card">{error}</p>}
    {templates.map((team) => <div key={team.id} className="metadata-card"><strong>{team.avatar} {team.name}</strong><p>{team.description}</p><small>{team.roleCount} 位角色 · {team.roleNames.join('、')}</small><div className="agent-actions"><button disabled={busy || loading} aria-label={`预览模板：${team.name}`} onClick={() => { void open(team.id) }}>预览</button><button disabled={busy || loading || !modelId} aria-label={`导入团队：${team.name}`} onClick={() => onImport(team.id, modelId)}>导入团队</button></div></div>)}
    {preview && <Dialog title={`模板预览：${preview.name}`} onClose={() => setPreview(null)}><p>{preview.description}</p>{preview.roles.map((role) => <section key={role.id} className="template-role"><h3>{role.avatar} {role.name}</h3><p>{role.title}</p><ul>{role.responsibilities.map((item) => <li key={item}>{item}</li>)}</ul><p>输出格式：{role.outputFormat}</p><pre className="template-prompt">{role.systemPrompt}</pre><button disabled={busy || !modelId} aria-label={`复制并编辑：${role.name}`} onClick={() => { onCopy(preview.id, role, modelId); setPreview(null) }}>复制并编辑</button></section>)}<div className="dialog-actions"><button onClick={() => setPreview(null)}>关闭预览</button></div></Dialog>}
  </section>
}
