import { useEffect, useState } from 'react'
import type { AgentEditorInput, AgentSummary, Channel, ModelConfigSummary, ToolName, ToolPermissions } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'

const tools: ToolName[] = ['list_dir', 'read_file', 'search_files', 'write_file', 'run_process']
const blank = (modelConfigId: string): AgentEditorInput => ({ name: '', avatar: null, title: '', systemPrompt: '', modelConfigId, defaultToolPermissions: {} as ToolPermissions })

export function AgentManager({ channel, models }: { channel?: Channel; models: ModelConfigSummary[] }) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [enabled, setEnabled] = useState('')
  const [editing, setEditing] = useState<string | undefined>()
  const [form, setForm] = useState<AgentEditorInput>(() => blank(''))
  const reload = async () => {
    setAgents(await window.agentTeam.agents.list())
    if (channel) setEnabled((await window.agentTeam.channelAgents.list(channel.id)).find((item) => item.isEnabled)?.agentId ?? '')
  }
  useEffect(() => { void reload() }, [channel?.id])
  useEffect(() => { if (!editing) setForm(blank(models[0]?.id ?? '')) }, [models, editing])
  if (!channel) return <EmptyState title="未选择群聊">选择群聊后可绑定一个单 Agent。</EmptyState>
  if (!models.length) return <EmptyState title="尚未配置模型">请先在模型设置中保存一个模型配置；当前不能创建 Agent。</EmptyState>
  const save = async () => {
    if (!form.name.trim() || !form.title.trim() || !form.systemPrompt.trim() || !form.modelConfigId) return
    const input = { ...form, name: form.name.trim(), title: form.title.trim(), systemPrompt: form.systemPrompt.trim() }
    if (editing) await window.agentTeam.agents.update(editing, input); else await window.agentTeam.agents.create(input)
    setEditing(undefined); await reload()
  }
  return <section aria-label="Agent 管理"><div className="agent-list">{agents.map((agent) => <div className="metadata-card agent-row" key={agent.id}><div><strong>{agent.name}</strong><small>{agent.title || '未填写角色'}</small></div><button aria-label={`编辑 Agent：${agent.name}`} onClick={async () => { setEditing(agent.id); setForm(await window.agentTeam.agents.get(agent.id)) }}>编辑</button><button aria-label={`设为当前 Agent：${agent.name}`} disabled={enabled === agent.id} onClick={async () => { await window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null }); await reload() }}>{enabled === agent.id ? '当前' : '设为当前'}</button><button aria-label={`删除 Agent：${agent.name}`} onClick={async () => { await window.agentTeam.agents.remove(agent.id); await reload() }}>删除</button></div>)}</div>
    {!agents.length && <EmptyState title="尚未创建 Agent">当前群聊将保持普通聊天模式。</EmptyState>}
    <form className="agent-editor" onSubmit={(event) => { event.preventDefault(); void save() }}><h3>{editing ? '编辑 Agent' : '创建 Agent'}</h3><label>名称<input aria-label="Agent 名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label>角色<input aria-label="Agent 角色" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label><label>系统提示<textarea aria-label="Agent 系统提示" value={form.systemPrompt} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} /></label><label>模型<select aria-label="Agent 模型" value={form.modelConfigId} onChange={(event) => setForm({ ...form, modelConfigId: event.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><fieldset><legend>工具权限（默认全部拒绝）</legend>{tools.map((tool) => <label key={tool}><input type="checkbox" checked={form.defaultToolPermissions[tool] === true} onChange={(event) => setForm({ ...form, defaultToolPermissions: { ...form.defaultToolPermissions, [tool]: event.target.checked } })} />{tool}</label>)}</fieldset><button type="submit" disabled={!form.name.trim() || !form.title.trim() || !form.systemPrompt.trim()}>{editing ? '保存 Agent' : '创建 Agent'}</button>{editing && <button type="button" onClick={() => setEditing(undefined)}>取消编辑</button>}</form></section>
}
