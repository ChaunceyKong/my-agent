import { useEffect, useRef, useState } from 'react'
import type { AgentEditorInput, AgentSummary, Channel, ChannelAgent, ConfigureChannelInput, ModelConfigSummary, ToolName, ToolPermissions } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'
import { TemplateMarket } from './TemplateMarket'

const tools: ToolName[] = ['list_dir', 'read_file', 'search_files', 'write_file', 'run_process']
const blank = (modelConfigId: string): AgentEditorInput => ({ name: '', avatar: null, title: '', systemPrompt: '', modelConfigId, defaultToolPermissions: {} })

export function AgentManager({ channel, models, onChannelChanged, onMembersChanged }: { channel?: Channel; models: ModelConfigSummary[]; onChannelChanged(channel: Channel): void; onMembersChanged?(): void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [members, setMembers] = useState<ChannelAgent[]>([])
  const [editing, setEditing] = useState<string | undefined>()
  const [copySource, setCopySource] = useState<{ templateId: string; roleId: string } | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<AgentEditorInput>(() => blank(''))
  const [memberForm, setMemberForm] = useState<{ agentId: string; isEnabled: boolean; modelConfigOverrideId: string | null; toolPermissionsOverride: ToolPermissions | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const currentChannel = useRef(channel?.id)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  currentChannel.current = channel?.id
  const reload = async (channelId = channel?.id) => {
    const [nextAgents, nextMembers] = await Promise.all([window.agentTeam.agents.list(), channelId ? window.agentTeam.channelAgents.list(channelId) : Promise.resolve([])])
    if (!mounted.current || currentChannel.current !== channelId) return
    setAgents(nextAgents); setMembers(nextMembers)
  }
  useEffect(() => {
    setEditing(undefined); setCopySource(null); setMemberForm(null); setError(''); setAgents([]); setMembers([])
    void reload().catch(() => setError('Agent 列表读取失败，请重新选择群聊'))
  }, [channel?.id])
  useEffect(() => { if (!editing && !copySource) setForm(blank(models[0]?.id ?? '')) }, [models, editing, copySource])
  useEffect(() => { if (copySource) { nameInput.current?.focus(); nameInput.current?.scrollIntoView?.({ block: 'center' }) } }, [copySource])
  if (!channel) return <EmptyState title="未选择群聊">选择群聊后可管理多个 Agent。</EmptyState>
  const act = async (operation: () => Promise<unknown>, message: string) => {
    if (busy) return
    const channelId = channel.id
    setBusy(true); setError('')
    try { await operation(); if (!mounted.current || currentChannel.current !== channelId) return; await reload(channelId); if (mounted.current && currentChannel.current === channelId) onMembersChanged?.() }
    catch (error) { if (mounted.current && currentChannel.current === channelId) setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : message) }
    finally { if (mounted.current && currentChannel.current === channelId) setBusy(false) }
  }
  const save = () => act(async () => {
    const input = { ...form, name: form.name.trim(), title: form.title.trim(), systemPrompt: form.systemPrompt.trim(), avatar: form.avatar?.trim() || null }
    if (copySource) {
      const { name, avatar, title, systemPrompt, modelConfigId } = input
      await window.agentTeam.templates.copyAgent({ ...copySource, channelId: channel.id, editor: { name, avatar, title, systemPrompt, modelConfigId } })
    } else if (editing) await window.agentTeam.agents.update(editing, input); else await window.agentTeam.agents.create(input)
    if (mounted.current && currentChannel.current === channel.id) { setEditing(undefined); setCopySource(null); setForm(blank(models[0]?.id ?? '')) }
  }, 'Agent 保存失败，请检查模型、名称和头像长度后重试')
  const editingMemberAgent = agents.find((agent) => agent.id === memberForm?.agentId)
  return <section aria-label="Agent 管理"><ChannelConfiguration channel={channel} models={models} onChanged={onChannelChanged} />
    <TemplateMarket channel={channel} models={models} busy={busy} onImport={(templateId, modelConfigId) => { void act(() => window.agentTeam.templates.importTeam({ templateId, modelConfigId, channelId: channel.id }), '团队导入失败，请结束当前任务后重试') }} onCopy={(templateId, role, modelConfigId) => { setEditing(undefined); setCopySource({ templateId, roleId: role.id }); setForm({ name: role.name, avatar: role.avatar, title: role.title, systemPrompt: role.systemPrompt, modelConfigId, defaultToolPermissions: {} }) }} />
    {error && <div className="error-card" role="alert">{error}</div>}
    <div className="agent-list">{agents.map((agent) => {
      const member = members.find((item) => item.agentId === agent.id)
      return <div className="metadata-card" key={agent.id}><div className="agent-row"><span className="avatar agent-avatar" aria-hidden="true">{agent.avatar || agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.title || '未填写角色'}</small><small>{member ? member.isEnabled ? '群聊中 · 已启用' : '群聊中 · 已停用' : '未加入群聊'}</small></div></div><div className="agent-actions">
        <button aria-label={`编辑 Agent：${agent.name}`} disabled={busy} onClick={() => { void act(async () => { const value = await window.agentTeam.agents.get(agent.id); if (mounted.current && currentChannel.current === channel.id) { setCopySource(null); setEditing(agent.id); setForm(value) } }, 'Agent 读取失败，请重试') }}>编辑</button>
        <button aria-label={`${member?.isEnabled ? '停用群聊 Agent' : member ? '启用群聊 Agent' : '加入群聊'}：${agent.name}`} disabled={busy} onClick={() => { void act(() => window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: !member?.isEnabled, modelConfigOverrideId: member?.modelConfigOverrideId ?? null, toolPermissionsOverride: member?.toolPermissionsOverride ?? null }), '群聊成员保存失败，请重试') }}>{member?.isEnabled ? '停用' : member ? '启用' : '加入群聊'}</button>
        {member && <><button aria-label={`群聊成员设置：${agent.name}`} disabled={busy} onClick={() => setMemberForm({ agentId: agent.id, isEnabled: member.isEnabled, modelConfigOverrideId: member.modelConfigOverrideId, toolPermissionsOverride: member.toolPermissionsOverride })}>群聊设置</button><button aria-label={`移出群聊：${agent.name}`} disabled={busy} onClick={() => { void act(async () => { await window.agentTeam.channelAgents.remove(channel.id, agent.id); if (currentChannel.current === channel.id) setMemberForm(null) }, '移出群聊失败，请重试') }}>移出</button></>}
        <button aria-label={`删除 Agent：${agent.name}`} disabled={busy} onClick={() => { void act(() => window.agentTeam.agents.remove(agent.id), 'Agent 仍被群聊或任务记录引用，请先处理相关记录') }}>删除</button>
      </div></div>
    })}</div>
    {!agents.length && <EmptyState title="尚未创建 Agent">当前群聊将保持普通聊天模式。</EmptyState>}
    {memberForm && editingMemberAgent && <form className="agent-editor" aria-label={`成员设置：${editingMemberAgent.name}`} onSubmit={(event) => {
      event.preventDefault(); void act(async () => { await window.agentTeam.channelAgents.save({ channelId: channel.id, ...memberForm }); if (currentChannel.current === channel.id) setMemberForm(null) }, '成员设置保存失败，权限只能缩小 Agent 默认权限')
    }}><h3>{editingMemberAgent.name} · 群聊设置</h3><label><input type="checkbox" checked={memberForm.isEnabled} onChange={(event) => setMemberForm({ ...memberForm, isEnabled: event.target.checked })} />在此群聊启用</label><label>群聊模型<select aria-label="群聊成员模型" value={memberForm.modelConfigOverrideId ?? ''} onChange={(event) => setMemberForm({ ...memberForm, modelConfigOverrideId: event.target.value || null })}><option value="">使用 Agent 默认模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><fieldset><legend>群聊工具权限</legend><label><input type="checkbox" checked={memberForm.toolPermissionsOverride === null} onChange={(event) => setMemberForm({ ...memberForm, toolPermissionsOverride: event.target.checked ? null : { ...editingMemberAgent.defaultToolPermissions } })} />使用 Agent 默认工具权限</label>{memberForm.toolPermissionsOverride !== null && tools.map((tool) => <label key={tool}><input aria-label={`群聊权限 ${tool}`} type="checkbox" disabled={editingMemberAgent.defaultToolPermissions[tool] !== true} checked={editingMemberAgent.defaultToolPermissions[tool] === true && memberForm.toolPermissionsOverride?.[tool] === true} onChange={(event) => setMemberForm({ ...memberForm, toolPermissionsOverride: { ...memberForm.toolPermissionsOverride, [tool]: event.target.checked } })} />{tool}{editingMemberAgent.defaultToolPermissions[tool] !== true && '（默认未授权）'}</label>)}</fieldset><button type="submit" disabled={busy}>保存成员设置</button><button type="button" disabled={busy} onClick={() => setMemberForm(null)}>取消成员设置</button></form>}
    {!models.length ? <EmptyState title="尚未配置模型">请先在模型设置中保存一个模型配置；当前不能创建 Agent。</EmptyState> : <form className="agent-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h3>{copySource ? '编辑模板副本' : editing ? '编辑 Agent' : '创建 Agent'}</h3>
      {copySource && <p className="form-note">来源：{copySource.templateId} / {copySource.roleId}。创建后自动加入当前群聊，原模板不变。先创建默认拒绝工具权限的副本，再通过「编辑」显式授权。</p>}
      <label>名称<input ref={nameInput} aria-label="Agent 名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>头像<input aria-label="Agent 头像" value={form.avatar ?? ''} placeholder="文字或 emoji，例如 ✍️" onChange={(event) => setForm({ ...form, avatar: event.target.value })} /></label>
      <p className="form-note">最多 16 个文字或 emoji，留空使用名称首字。</p>
      <label>角色<input aria-label="Agent 角色" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
      <label>系统提示<textarea aria-label="Agent 系统提示" value={form.systemPrompt} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} /></label>
      <label>模型<select aria-label="Agent 模型" value={form.modelConfigId} onChange={(event) => setForm({ ...form, modelConfigId: event.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label>
      <fieldset><legend>工具权限（默认全部拒绝）</legend>{tools.map((tool) => <label key={tool}><input type="checkbox" disabled={busy || !!copySource} checked={form.defaultToolPermissions[tool] === true} onChange={(event) => setForm({ ...form, defaultToolPermissions: { ...form.defaultToolPermissions, [tool]: event.target.checked } })} />{tool}</label>)}</fieldset>
      <button type="submit" disabled={busy || !form.name.trim() || !form.title.trim() || !form.systemPrompt.trim() || !form.modelConfigId}>{copySource ? '创建模板副本' : editing ? '保存 Agent' : '创建 Agent'}</button>
      {(editing || copySource) && <button type="button" disabled={busy} onClick={() => { setEditing(undefined); setCopySource(null) }}>取消编辑</button>}
    </form>}
  </section>
}

function ChannelConfiguration({ channel, models, onChanged }: { channel: Channel; models: ModelConfigSummary[]; onChanged(channel: Channel): void }) {
  const [form, setForm] = useState<ConfigureChannelInput>({ channelId: channel.id, speakerMode: channel.speakerMode, maxTurns: channel.maxTurns, schedulerModelConfigId: channel.schedulerModelConfigId })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const current = useRef(channel.id)
  current.current = channel.id
  useEffect(() => () => { current.current = '' }, [])
  useEffect(() => { setForm({ channelId: channel.id, speakerMode: channel.speakerMode, maxTurns: channel.maxTurns, schedulerModelConfigId: channel.schedulerModelConfigId }); setError('') }, [channel])
  return <form className="agent-editor metadata-card" aria-label="群聊调度设置" onSubmit={async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('')
    const channelId = channel.id
    try { const saved = await window.agentTeam.channels.configure(form); if (current.current === channelId) onChanged(saved) } catch { if (current.current === channelId) setError('群聊配置保存失败，请检查模型和轮数后重试') } finally { if (current.current === channelId) setBusy(false) }
  }}><h3>群聊调度</h3><label>发言模式<select aria-label="发言模式" value={form.speakerMode} onChange={(event) => setForm({ ...form, speakerMode: event.target.value as Channel['speakerMode'] })}><option value="automatic">自动调度</option><option value="manual">CEO 手动指派</option></select></label><label>调度模型<select aria-label="群聊调度模型" value={form.schedulerModelConfigId ?? ''} onChange={(event) => setForm({ ...form, schedulerModelConfigId: event.target.value || null })}><option value="">使用模型中心默认调度模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><label>轮数上限<input aria-label="群聊轮数上限" type="number" min="1" max="100" value={form.maxTurns} onChange={(event) => setForm({ ...form, maxTurns: Number(event.target.value) })} /></label>{error && <div className="error-card" role="alert">{error}</div>}<button type="submit" disabled={busy || !Number.isSafeInteger(form.maxTurns) || form.maxTurns < 1 || form.maxTurns > 100}>保存群聊配置</button></form>
}
