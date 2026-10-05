import { useEffect, useRef, useState } from 'react'
import type { AgentTemplate, AgentTemplateRole, Channel, ModelConfigSummary } from '../../../shared/types'

export function TemplateMarket({ channel, models, busy, onImport, onRoleImport, onCopy }: {
  channel: Channel; models: ModelConfigSummary[]; busy: boolean
  onImport(templateId: string, modelConfigId: string): void
  onRoleImport(templateId: string, role: AgentTemplateRole, modelConfigId: string): void
  onCopy(templateId: string, role: AgentTemplateRole, modelConfigId: string): void
}) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [preview, setPreview] = useState<AgentTemplate | null>(null)
  const [modelId, setModelId] = useState(models[0]?.id ?? '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const revision = useRef(0)
  useEffect(() => {
    const generation = ++revision.current
    void window.agentTeam.templates.list().then((items) => Promise.all(items.map((item) => window.agentTeam.templates.get(item.id))))
      .then((items) => { if (revision.current === generation) setTemplates(items) })
      .catch(() => { if (revision.current === generation) setError('推荐实例读取失败，请重新打开弹窗') })
      .finally(() => { if (revision.current === generation) setLoading(false) })
    return () => { revision.current++ }
  }, [channel.id])
  useEffect(() => { if (!models.some((model) => model.id === modelId)) setModelId(models[0]?.id ?? '') }, [models, modelId])
  return <section aria-label="Agent 模板市场" className="template-market"><h3>推荐 Agent 实例</h3><p className="form-note">选择单个角色直接导入「{channel.name}」，也可导入整支团队。实例支持编辑，工具权限默认关闭。</p>
    <label>模板导入模型<select aria-label="模板导入模型" disabled={busy || loading} value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">请选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label>
    {error && <p role="alert" className="error-card">{error}</p>}
    {!models.length && <p className="form-note">请先在模型设置中保存模型配置，再导入实例。</p>}
    {loading && <p role="status">正在加载推荐实例…</p>}
    {!loading && !error && !templates.length && <p className="form-note">暂无推荐实例，可切换到自定义 Agent。</p>}
    {preview ? <section aria-label={`模板预览：${preview.name}`}><div className="agent-section-heading"><h3>{preview.avatar} {preview.name}</h3><button disabled={busy} onClick={() => setPreview(null)}>关闭预览</button></div><p>{preview.description}</p>{preview.roles.map((role) => <section key={role.id} className="template-role"><h3>{role.avatar} {role.name}</h3><p>{role.title}</p><ul>{role.responsibilities.map((item) => <li key={item}>{item}</li>)}</ul><p>输出格式：{role.outputFormat}</p><pre className="template-prompt">{role.systemPrompt}</pre><div className="agent-actions"><button disabled={busy || !modelId} aria-label={`导入 Agent：${role.name}`} onClick={() => onRoleImport(preview.id, role, modelId)}>直接导入</button><button disabled={busy || !modelId} aria-label={`复制并编辑：${role.name}`} onClick={() => onCopy(preview.id, role, modelId)}>复制并编辑</button></div></section>)}</section>
      : templates.map((team) => <div key={team.id} className="metadata-card"><strong>{team.avatar} {team.name}</strong><p>{team.description}</p><div className="agent-actions"><button disabled={busy} aria-label={`预览模板：${team.name}`} onClick={() => setPreview(team)}>预览配置</button><button disabled={busy || !modelId} aria-label={`导入团队：${team.name}`} onClick={() => onImport(team.id, modelId)}>导入整支团队 · {team.roles.length} 人</button></div>{team.roles.map((role) => <div className="recommended-agent" key={role.id}><div><strong>{role.avatar} {role.name}</strong><small>{role.title}</small></div><div className="agent-actions"><button className="primary-button" disabled={busy || !modelId} aria-label={`导入 Agent：${role.name}`} onClick={() => onRoleImport(team.id, role, modelId)}>导入</button><button disabled={busy || !modelId} aria-label={`复制并编辑：${role.name}`} onClick={() => onCopy(team.id, role, modelId)}>自定义</button></div></div>)}</div>)}
  </section>
}
