import { useEffect, useState } from 'react'
import type { AgentSummary, Channel, ModelConfigSummary } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'

export function AgentManager({ channel, models }: { channel?: Channel; models: ModelConfigSummary[] }) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [enabled, setEnabled] = useState('')
  const [name, setName] = useState('')
  const reload = async () => {
    const list = await window.agentTeam.agents.list()
    setAgents(list)
    if (channel) setEnabled((await window.agentTeam.channelAgents.list(channel.id)).find((item) => item.isEnabled)?.agentId ?? '')
  }
  useEffect(() => { void reload() }, [channel?.id])
  if (!channel) return <EmptyState title="未选择群聊">选择群聊后可绑定一个单 Agent。</EmptyState>
  if (!models.length) return <EmptyState title="尚未配置模型">请先在模型设置中保存一个模型配置。</EmptyState>
  return <section aria-label="Agent 管理"><div className="agent-list">{agents.map((agent) => <div className="metadata-card agent-row" key={agent.id}><div><strong>{agent.name}</strong><small>{agent.title || '未填写角色'}</small></div><button aria-label={`设为当前 Agent：${agent.name}`} disabled={enabled === agent.id} onClick={async () => { await window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null }); await reload() }}>{enabled === agent.id ? '当前' : '设为当前'}</button><button aria-label={`删除 Agent：${agent.name}`} onClick={async () => { await window.agentTeam.agents.remove(agent.id); await reload() }}>删除</button></div>)}</div>
    {!agents.length && <EmptyState title="尚未创建 Agent">当前群聊将保持普通聊天模式。</EmptyState>}
    <form className="agent-create" onSubmit={async (event) => { event.preventDefault(); if (!name.trim()) return; await window.agentTeam.agents.create({ name: name.trim(), avatar: null, title: '协作 Agent', systemPrompt: '你是一个谨慎的协作助手。', modelConfigId: models[0].id, defaultToolPermissions: { list_dir: true, read_file: true, search_files: true, write_file: true, run_process: true } }); setName(''); await reload() }}><label>新 Agent 名称<input aria-label="新 Agent 名称" value={name} onChange={(event) => setName(event.target.value)} /></label><button type="submit">创建 Agent</button></form></section>
}
