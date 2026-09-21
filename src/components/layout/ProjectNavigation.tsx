import type { Channel, Project } from '../../../shared/types'

interface Props {
  projects: Project[]; channels: Channel[]; projectId: string; channelId: string
  onProject(id: string): void; onChannel(id: string): void
  onNewProject(): void; onNewChannel(): void; onSettings(): void
}
export function ProjectNavigation(props: Props) {
  const project = props.projects.find((item) => item.id === props.projectId)
  return <aside className="project-navigation" aria-label="项目与群聊导航"><div className="project-picker"><div className="section-label"><span>当前本地项目</span><button className="text-button" onClick={props.onNewProject}>新建项目</button></div><label className="sr-only" htmlFor="project-select">选择项目</label><select id="project-select" value={props.projectId} onChange={(event) => props.onProject(event.target.value)}><option value="" disabled>选择或创建项目</option>{props.projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select><p className="workspace-path" title={project?.workspacePath}>{project?.workspacePath ?? '一个项目，绑定一个本地目录'}</p></div><nav className="channel-navigation" aria-label="会话群聊"><div className="section-label">项目会话群聊</div>{props.channels.map((channel) => <button key={channel.id} className={`channel-button ${props.channelId === channel.id ? 'selected' : ''}`} aria-label={channel.name} aria-current={props.channelId === channel.id ? 'page' : undefined} onClick={() => props.onChannel(channel.id)}><span aria-hidden="true">#</span><span>{channel.name}</span></button>)}<button className="new-channel" disabled={!project} onClick={props.onNewChannel}>新建会话群聊</button></nav><div className="owner-card"><span className="avatar ceo-avatar" aria-hidden="true">♛</span><div><strong>主理人 (CEO)</strong><small>本地协作空间</small></div><button className="icon-button" aria-label="模型设置" onClick={props.onSettings}>⚙</button></div></aside>
}
