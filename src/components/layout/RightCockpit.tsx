import { useState } from 'react'
import type { Channel, ModelConfigSummary, Project } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'

export function RightCockpit({ project, channel, model }: { project?: Project; channel?: Channel; model?: ModelConfigSummary }) {
  const [tab, setTab] = useState('members')
  const tabs = [['members', '成员状态'], ['files', '工作区文件'], ['context', '团队上下文']]
  return <aside id="right-cockpit" className="right-cockpit" aria-label="团队与工作区"><div className="cockpit-title">团队与工作区<span>v0.1</span></div><div className="cockpit-tabs" role="tablist" aria-label="工作台视窗">{tabs.map(([id, label], index) => <button key={id} id={`tab-${id}`} role="tab" aria-controls="cockpit-content" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3][0]
    setTab(next); document.getElementById(`tab-${next}`)?.focus()
  }}>{label}</button>)}</div><div id="cockpit-content" role="tabpanel" aria-labelledby={`tab-${tab}`} className="cockpit-content">
    {tab === 'members' && <EmptyState title="团队成员待开放">当前版本尚未启用团队成员与多 Agent 协作。对话由你选择的单个模型响应。</EmptyState>}
    {tab === 'files' && <><div className="metadata-card"><h3>项目绑定目录</h3><p className="path-text">{project?.workspacePath ?? '尚未绑定目录'}</p></div><EmptyState title="文件浏览待开放">当前版本尚未提供文件浏览、监听或文件操作。聊天不会读写项目目录中的文件。</EmptyState></>}
    {tab === 'context' && <><div className="metadata-card"><h3>当前项目与会话</h3><dl><dt>项目</dt><dd>{project?.name ?? '未选择'}</dd><dt>群聊</dt><dd>{channel?.name ?? '未选择'}</dd><dt>模型</dt><dd>{model?.modelName ?? '未配置'}</dd><dt>工作目录</dt><dd className="path-text">{project?.workspacePath ?? '未绑定'}</dd></dl></div><EmptyState title="上下文说明">同一项目下的群聊各自保留对话历史。自动摘要与交付成果提取尚未提供。</EmptyState></>}
  </div></aside>
}
