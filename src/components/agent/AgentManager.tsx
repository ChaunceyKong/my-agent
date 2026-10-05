import { useEffect, useRef, useState } from 'react'
import type { AgentEditorInput, AgentSummary, Channel, ChannelAgent, ConfigureChannelInput, ModelConfigSummary, ToolName, ToolPermissions } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'
import { Dialog } from '../common/Dialog'
import { TemplateMarket } from './TemplateMarket'

const tools: ToolName[] = ['list_dir', 'read_file', 'search_files', 'write_file', 'run_process']
const blank = (modelConfigId: string): AgentEditorInput => ({ name: '', avatar: null, title: '', systemPrompt: '', modelConfigId, defaultToolPermissions: {} })

export function AgentManager({ channel, models, onChannelChanged, onMembersChanged }: { channel?: Channel; models: ModelConfigSummary[]; onChannelChanged(channel: Channel): void; onMembersChanged?(): void }) {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [members, setMembers] = useState<ChannelAgent[]>([])
  const [dialog, setDialog] = useState<'add' | 'edit' | 'member' | null>(null)
  const [addTab, setAddTab] = useState<'custom' | 'recommended' | 'existing'>('custom')
  const [loading, setLoading] = useState(true)
  const createdAgent = useRef<string | null>(null)
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
    setAgents(nextAgents); setMembers(nextMembers); setLoading(false)
  }
  useEffect(() => {
    setDialog(null); setEditing(undefined); setCopySource(null); setMemberForm(null); setError(''); setBusy(false); setLoading(true); setAgents([]); setMembers([]); createdAgent.current = null
    const channelId = channel?.id
    void reload(channelId).catch(() => { if (mounted.current && currentChannel.current === channelId) { setLoading(false); setError('Agent 列表读取失败，请重新选择群聊') } })
  }, [channel?.id])
  useEffect(() => { if (!editing && !copySource) setForm(blank(models[0]?.id ?? '')) }, [models, editing, copySource])
  useEffect(() => { if (copySource) { nameInput.current?.focus(); nameInput.current?.scrollIntoView?.({ block: 'center' }) } }, [copySource])
  if (!channel) return <EmptyState title="未选择群聊">选择群聊后可管理多个 Agent。</EmptyState>
  const closeDialog = () => { setDialog(null); setEditing(undefined); setCopySource(null); setMemberForm(null); setError(''); createdAgent.current = null }
  const openAdd = () => { closeDialog(); setForm(blank(models[0]?.id ?? '')); setAddTab('custom'); setDialog('add') }
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
    } else if (editing) await window.agentTeam.agents.update(editing, input)
    else {
      // Retain the created ID if joining fails, so retrying never creates a duplicate.
      const agent = createdAgent.current ? await window.agentTeam.agents.update(createdAgent.current, input) : await window.agentTeam.agents.create(input)
      if (mounted.current && currentChannel.current === channel.id) {
        createdAgent.current = agent.id
        setAgents((items) => [...items.filter((item) => item.id !== agent.id), agent])
      }
      await window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    }
    if (mounted.current && currentChannel.current === channel.id) closeDialog()
  }, 'Agent 保存失败，请检查模型、名称和头像长度后重试')
  const importTemplate = (operation: () => Promise<unknown>) => { void act(async () => { await operation(); if (mounted.current && currentChannel.current === channel.id) closeDialog() }, 'Agent 导入失败，请结束当前任务后重试') }
  const editingMemberAgent = agents.find((agent) => agent.id === memberForm?.agentId)
  const currentAgents = agents.filter((agent) => members.some((member) => member.agentId === agent.id))
  const availableAgents = agents.filter((agent) => !members.some((member) => member.agentId === agent.id))
  return <section aria-label="Agent 管理">
    <div className="agent-section-heading"><div><h3>当前群聊 Agent <span>{currentAgents.length}</span></h3><p>{channel.name} · {members.filter((member) => member.isEnabled).length} 位已启用</p></div><button className="primary-button" disabled={busy || loading} onClick={openAdd}>＋ 添加 Agent</button></div>
    {error && !dialog && <div className="error-card" role="alert">{error}</div>}
    {loading && <p role="status" className="form-note">正在读取群聊成员…</p>}
    <div className="agent-list">{currentAgents.map((agent) => {
      const member = members.find((item) => item.agentId === agent.id)
      return <div className="metadata-card" key={agent.id}><div className="agent-row"><span className="avatar agent-avatar" aria-hidden="true">{agent.avatar || agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.title || '未填写角色'}</small><small>{models.find((model) => model.id === (member?.modelConfigOverrideId ?? agent.modelConfigId))?.modelName ?? '模型未配置'}</small></div><span className={`agent-status ${member?.isEnabled ? 'enabled' : ''}`}>{member?.isEnabled ? '已启用' : '已停用'}</span></div><div className="agent-actions">
        <button aria-label={`编辑 Agent：${agent.name}`} disabled={busy} onClick={() => { void act(async () => { const value = await window.agentTeam.agents.get(agent.id); if (mounted.current && currentChannel.current === channel.id) { setCopySource(null); setEditing(agent.id); setForm(value); setDialog('edit') } }, 'Agent 读取失败，请重试') }}>编辑</button>
        <button aria-label={`${member?.isEnabled ? '停用群聊 Agent' : member ? '启用群聊 Agent' : '加入群聊'}：${agent.name}`} disabled={busy} onClick={() => { void act(() => window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: !member?.isEnabled, modelConfigOverrideId: member?.modelConfigOverrideId ?? null, toolPermissionsOverride: member?.toolPermissionsOverride ?? null }), '群聊成员保存失败，请重试') }}>{member?.isEnabled ? '停用' : member ? '启用' : '加入群聊'}</button>
        {member && <><button aria-label={`群聊成员设置：${agent.name}`} disabled={busy} onClick={() => { setError(''); setMemberForm({ agentId: agent.id, isEnabled: member.isEnabled, modelConfigOverrideId: member.modelConfigOverrideId, toolPermissionsOverride: member.toolPermissionsOverride }); setDialog('member') }}>群聊设置</button><button aria-label={`移出群聊：${agent.name}`} disabled={busy} onClick={() => { void act(async () => { await window.agentTeam.channelAgents.remove(channel.id, agent.id); if (currentChannel.current === channel.id) setMemberForm(null) }, '移出群聊失败，请重试') }}>移出</button></>}
      </div></div>
    })}</div>
    {!loading && !currentAgents.length && <EmptyState title="当前群聊还没有 Agent">点击「添加 Agent」自定义成员，或直接导入推荐实例。</EmptyState>}
    <details className="agent-scheduling"><summary>群聊调度设置</summary><ChannelConfiguration channel={channel} models={models} onChanged={onChannelChanged} /></details>
    {dialog && <Dialog title={dialog === 'add' ? '添加 Agent' : dialog === 'edit' ? '编辑 Agent' : '群聊成员设置'} busy={busy} onClose={closeDialog}>
    {error && <div className="error-card" role="alert">{error}</div>}
    {dialog === 'add' && <><p className="form-note">添加到「{channel.name}」，保存后即可在群聊中选择或 @ 该 Agent。</p><div className="agent-add-tabs" role="group" aria-label="添加 Agent 方式">{([['custom', '自定义 Agent'], ['recommended', '推荐实例'], ['existing', '已有 Agent']] as const).map(([id, label]) => <button key={id} disabled={busy} aria-pressed={addTab === id} onClick={() => { setAddTab(id); setError(''); setCopySource(null); setForm(blank(models[0]?.id ?? '')); createdAgent.current = null }}>{label}</button>)}</div></>}
    {dialog === 'add' && addTab === 'recommended' && <TemplateMarket channel={channel} models={models} busy={busy} onImport={(templateId, modelConfigId) => importTemplate(() => window.agentTeam.templates.importTeam({ templateId, modelConfigId, channelId: channel.id }))} onRoleImport={(templateId, role, modelConfigId) => importTemplate(() => window.agentTeam.templates.copyAgent({ templateId, roleId: role.id, channelId: channel.id, editor: { name: role.name, avatar: role.avatar, title: role.title, systemPrompt: role.systemPrompt, modelConfigId } }))} onCopy={(templateId, role, modelConfigId) => { setEditing(undefined); setCopySource({ templateId, roleId: role.id }); setAddTab('custom'); setForm({ name: role.name, avatar: role.avatar, title: role.title, systemPrompt: role.systemPrompt, modelConfigId, defaultToolPermissions: {} }) }} />}
    {dialog === 'add' && addTab === 'existing' && <div className="agent-list">{availableAgents.map((agent) => <div className="metadata-card" key={agent.id}><div className="agent-row"><span className="avatar agent-avatar" aria-hidden="true">{agent.avatar || agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.title || '未填写角色'}</small></div></div><button disabled={busy} aria-label={`加入群聊：${agent.name}`} onClick={() => { void act(async () => { await window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null }); if (mounted.current && currentChannel.current === channel.id) closeDialog() }, '加入群聊失败，请重试') }}>加入群聊</button><button disabled={busy} aria-label={`删除 Agent：${agent.name}`} onClick={() => { void act(() => window.agentTeam.agents.remove(agent.id), 'Agent 仍被群聊或任务记录引用，请先处理相关记录') }}>删除</button></div>)}{!availableAgents.length && <EmptyState title="没有可添加的已有 Agent">可通过自定义或推荐实例创建新成员。</EmptyState>}</div>}
    {dialog === 'member' && memberForm && editingMemberAgent && <form className="agent-editor" aria-label={`成员设置：${editingMemberAgent.name}`} onSubmit={(event) => {
      event.preventDefault(); void act(async () => { await window.agentTeam.channelAgents.save({ channelId: channel.id, ...memberForm }); if (currentChannel.current === channel.id) closeDialog() }, '成员设置保存失败，权限只能缩小 Agent 默认权限')
    }}><h3>{editingMemberAgent.name} · 群聊设置</h3><label><input type="checkbox" checked={memberForm.isEnabled} onChange={(event) => setMemberForm({ ...memberForm, isEnabled: event.target.checked })} />在此群聊启用</label><label>群聊模型<select aria-label="群聊成员模型" value={memberForm.modelConfigOverrideId ?? ''} onChange={(event) => setMemberForm({ ...memberForm, modelConfigOverrideId: event.target.value || null })}><option value="">使用 Agent 默认模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><fieldset><legend>群聊工具权限</legend><label><input type="checkbox" checked={memberForm.toolPermissionsOverride === null} onChange={(event) => setMemberForm({ ...memberForm, toolPermissionsOverride: event.target.checked ? null : { ...editingMemberAgent.defaultToolPermissions } })} />使用 Agent 默认工具权限</label>{memberForm.toolPermissionsOverride !== null && tools.map((tool) => <label key={tool}><input aria-label={`群聊权限 ${tool}`} type="checkbox" disabled={editingMemberAgent.defaultToolPermissions[tool] !== true} checked={editingMemberAgent.defaultToolPermissions[tool] === true && memberForm.toolPermissionsOverride?.[tool] === true} onChange={(event) => setMemberForm({ ...memberForm, toolPermissionsOverride: { ...memberForm.toolPermissionsOverride, [tool]: event.target.checked } })} />{tool}{editingMemberAgent.defaultToolPermissions[tool] !== true && '（默认未授权）'}</label>)}</fieldset><button type="submit" disabled={busy}>保存成员设置</button><button type="button" disabled={busy} onClick={closeDialog}>取消成员设置</button></form>}
    {(dialog === 'edit' || (dialog === 'add' && addTab === 'custom')) && (!models.length ? <EmptyState title="尚未配置模型">请先在模型设置中保存一个模型配置；当前不能创建 Agent。</EmptyState> : <form className="agent-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <h3>{copySource ? '编辑模板副本' : editing ? '编辑 Agent' : '创建 Agent'}</h3>
      {copySource && <p className="form-note">来源：{copySource.templateId} / {copySource.roleId}。创建后自动加入当前群聊，原模板不变。先创建默认拒绝工具权限的副本，再通过「编辑」显式授权。</p>}
      {editing && <p className="form-note">此配置由所有使用该 Agent 的群聊共享。仅调整当前群聊的模型或权限，请使用「群聊设置」。</p>}
      <label>名称<input ref={nameInput} aria-label="Agent 名称" value={form.name} placeholder="例如：选题策划师" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>头像<input aria-label="Agent 头像" value={form.avatar ?? ''} placeholder="文字或 emoji，例如 ✍️" onChange={(event) => setForm({ ...form, avatar: event.target.value })} /></label>
      <p className="form-note">最多 16 个文字或 emoji，留空使用名称首字。</p>
      <label>角色<input aria-label="Agent 角色" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
      <label>系统提示<textarea aria-label="Agent 系统提示" rows={5} placeholder="描述职责、工作方式和输出要求" value={form.systemPrompt} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} /></label>
      <label>模型<select aria-label="Agent 模型" value={form.modelConfigId} onChange={(event) => setForm({ ...form, modelConfigId: event.target.value })}>{models.map((model) => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label>
      <fieldset><legend>工具权限（默认全部拒绝）</legend>{tools.map((tool) => <label key={tool}><input type="checkbox" disabled={busy || !!copySource} checked={form.defaultToolPermissions[tool] === true} onChange={(event) => setForm({ ...form, defaultToolPermissions: { ...form.defaultToolPermissions, [tool]: event.target.checked } })} />{tool}</label>)}</fieldset>
      <div className="dialog-actions"><button type="button" disabled={busy} onClick={closeDialog}>取消</button><button className="primary-button" type="submit" disabled={busy || !form.name.trim() || !form.title.trim() || !form.systemPrompt.trim() || !form.modelConfigId}>{copySource ? '创建模板副本' : editing ? '保存 Agent' : '创建并加入群聊'}</button></div>
    </form>)}
    </Dialog>}
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
