import { useEffect, useState, useSyncExternalStore } from 'react'
import { createWorkbenchStore, emptyConversation, type WorkbenchStore } from './stores/workbench-store'
import { AppHeader } from './components/layout/AppHeader'
import { ProjectNavigation } from './components/layout/ProjectNavigation'
import { RightCockpit } from './components/layout/RightCockpit'
import { MessageStream } from './components/chat/MessageStream'
import { Composer } from './components/chat/Composer'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { CloudConsentDialog } from './components/settings/CloudConsentDialog'
import { EmptyState } from './components/common/EmptyState'
import { Dialog } from './components/common/Dialog'

export default function App(): JSX.Element {
  if (!window.agentTeam) return <main className="desktop-unavailable"><EmptyState title="请在桌面应用中打开">此工作台需要桌面服务连接才能读取本地项目和发送消息。</EmptyState></main>
  return <Workbench />
}

function Workbench() {
  const [store] = useState(() => createWorkbenchStore(window.agentTeam))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [cockpitOpen, setCockpitOpen] = useState(true)
  const [dialog, setDialog] = useState<'project' | 'channel' | 'settings' | null>(null)
  useEffect(() => store.connect(), [store])
  const project = state.projects.find((item) => item.id === state.projectId)
  const channel = state.channels.find((item) => item.id === state.channelId)
  const model = state.models.find((item) => item.id === state.modelId)
  const conversation = state.conversations[state.channelId] ?? emptyConversation
  const consentProject = state.projects.find((item) => item.id === state.consent?.projectId)
  const consentModel = state.models.find((item) => item.id === state.consent?.modelConfigId)
  return <div className="app-shell"><AppHeader project={project} channel={channel} cockpitOpen={cockpitOpen} onToggle={() => setCockpitOpen(!cockpitOpen)} /><div className={`workbench ${cockpitOpen ? '' : 'cockpit-closed'}`}>
    <ProjectNavigation projects={state.projects} channels={state.channels} projectId={state.projectId} channelId={state.channelId} onProject={(id) => { void store.selectProject(id) }} onChannel={(id) => { void store.selectChannel(id) }} onNewProject={() => setDialog('project')} onNewChannel={() => setDialog('channel')} onSettings={() => setDialog('settings')} />
    <main className="chat-panel"><div className="chat-heading"><div><span className="eyebrow">项目会话</span><h1>{channel?.name ?? '你的协作工作台'}</h1></div>{project && <span className="chat-workspace" title={project.workspacePath}>{project.workspacePath}</span>}</div>
      {state.error && <div className="error-card" role="alert">{state.error}<button className="text-button" onClick={() => { void store.initialize() }}>重新加载</button></div>}
      {state.loading ? <div className="loading-state">正在读取本地项目…</div> : !channel ? <div className="welcome-panel"><EmptyState title={project ? '选择或创建一个群聊' : '让想法在这里开始'}>{project ? '为不同主题建立独立会话，保留清晰的对话历史。' : '新建项目并绑定本地目录，然后配置模型，开始第一次对话。'}</EmptyState></div> : <MessageStream conversation={conversation} />}
      <Composer draft={conversation.draft} models={state.models} modelId={state.modelId} disabled={!channel || !conversation.loaded} sending={state.sending} running={conversation.runs.some((run) => run.status === 'running')} onDraft={store.setDraft} onModel={store.setModel} onSend={() => { void store.send() }} onCancel={() => { void store.cancel() }} onSettings={() => setDialog('settings')} />
    </main>
    {cockpitOpen && <RightCockpit project={project} channel={channel} model={model} />}
  </div>{dialog === 'settings' && <SettingsDialog onSave={store.saveModel} onClose={() => setDialog(null)} />}{(dialog === 'project' || dialog === 'channel') && <CreationDialog kind={dialog} store={store} onClose={() => setDialog(null)} />}{state.consent && consentProject && consentModel && <CloudConsentDialog project={consentProject} model={consentModel} busy={state.sending} onConfirm={store.grantConsent} onClose={store.dismissConsent} />}</div>
}

function CreationDialog({ kind, store, onClose }: { kind: 'project' | 'channel'; store: WorkbenchStore; onClose(): void }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [firstChannel, setFirstChannel] = useState('主线任务协同群')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project = kind === 'project'
  return <Dialog title={project ? '新建本地项目' : '新建会话群聊'} busy={busy} onClose={onClose}><form onSubmit={async (event) => {
    event.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError('')
    try {
      if (project) await store.createProject({ name: name.trim(), workspacePath: path.trim(), firstChannelName: firstChannel.trim(), browseForWorkspace: !path.trim() })
      else await store.createChannel(name.trim())
      onClose()
    } catch { setError(project ? '项目未创建，请选择有效的本地目录并确认读写权限后重试' : '群聊创建失败，请重试') }
    finally { setBusy(false) }
  }}><label>{project ? '项目名称' : '群聊名称'}<input required autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder={project ? '例如：内容矩阵' : '例如：选题讨论'} /></label>{project && <><label>本地目录<input value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} placeholder="留空将在确认时打开系统目录选择器" /></label><p className="form-note">填写已有目录的绝对路径，或留空后点击确认创建项目，在系统窗口中选择目录。</p><label>首个群聊名称<input required value={firstChannel} disabled={busy} onChange={(event) => setFirstChannel(event.target.value)} /></label></>}{error && <div className="error-card" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !name.trim() || (project && !firstChannel.trim())}>{busy ? '正在创建…' : project ? '确认创建项目' : '确认建群'}</button></div></form></Dialog>
}
