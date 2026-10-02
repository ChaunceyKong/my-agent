import { useEffect, useRef, useState } from 'react'
import type { AgentTeamApi, Channel, ModelConfigSummary, ProjectSummary, TaskRun } from '../../../shared/types'
import { EmptyState } from '../common/EmptyState'
import { AgentManager } from '../agent/AgentManager'
import { ToolCard } from '../agent/ToolCard'
import { ApprovalCard } from '../agent/ApprovalCard'
import { WorkspaceTree } from '../agent/WorkspaceTree'

export function RightCockpit({ project, channel, model, models, run, revision, onRefresh, onChannelChanged }: { project?: ProjectSummary; channel?: Channel; model?: ModelConfigSummary; models: ModelConfigSummary[]; run?: TaskRun; revision: number; onRefresh(): void; onChannelChanged(channel: Channel): void }) {
  const [tab, setTab] = useState('members')
  const tabs = [['members', 'Agent'], ['files', '工作区文件'], ['tools', '工具与审批'], ['context', '团队上下文']]
  return <aside id="right-cockpit" className="right-cockpit" aria-label="团队与工作区"><div className="cockpit-title">团队与工作区<span>v0.4</span></div><div className="cockpit-tabs" role="tablist" aria-label="工作台视窗">{tabs.map(([id, label], index) => <button key={id} id={`tab-${id}`} role="tab" aria-controls="cockpit-content" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0]
    setTab(next); document.getElementById(`tab-${next}`)?.focus()
  }}>{label}</button>)}</div><div id="cockpit-content" role="tabpanel" aria-labelledby={`tab-${tab}`} className="cockpit-content">
    {tab === 'members' && <AgentManager key={channel?.id} channel={channel} models={models} onChannelChanged={onChannelChanged} onMembersChanged={onRefresh} />}
    {tab === 'files' && <WorkspaceTree channel={channel} />}
    {tab === 'tools' && <RunTools key={`${channel?.id}:${run?.id}:${run?.generation}`} run={run} revision={revision} onRefresh={onRefresh} />}
    {tab === 'context' && <><div className="metadata-card"><h3>当前项目与会话</h3><dl><dt>项目</dt><dd>{project?.name ?? '未选择'}</dd><dt>群聊</dt><dd>{channel?.name ?? '未选择'}</dd><dt>模型</dt><dd>{model?.modelName ?? '未配置'}</dd><dt>工作目录</dt><dd>已绑定本地目录</dd><dt>协作模式</dt><dd>{channel?.speakerMode === 'manual' ? 'CEO 手动指派' : '串行自动调度'}</dd><dt>轮次上限</dt><dd>{channel?.maxTurns ?? 30}</dd></dl></div><EmptyState title="上下文说明">Agent 使用完整当前输入、预算内历史与既有摘要。每完成 10 轮，已授权的调度模型可生成会话摘要；摘要失败保留此前内容。任务、审批与工具状态始终来自持久化记录。</EmptyState></>}
  </div></aside>
}

/** A new scope mounts empty immediately, so old approvals cannot be clicked during new reads. */
function RunTools({ run, revision, onRefresh }: { run?: TaskRun; revision: number; onRefresh(): void }) {
  const [tools, setTools] = useState<Awaited<ReturnType<AgentTeamApi['tools']['list']>>>([])
  const [approvals, setApprovals] = useState<Awaited<ReturnType<AgentTeamApi['approvals']['list']>>>([])
  const [reload, setReload] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let disposed = false; let read = 0
    const refresh = async () => {
      if (!run) return
      const request = ++read
      try {
        const [nextTools, nextApprovals] = await Promise.all([window.agentTeam.tools.list(run.id), window.agentTeam.approvals.list(run.id)])
        if (!disposed && request === read) { setTools(nextTools); setApprovals(nextApprovals) }
      } catch { if (!disposed && request === read) { setTools([]); setApprovals([]) } }
    }
    void refresh(); const timer = setInterval(() => { void refresh() }, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [run?.id, run?.generation, revision, reload])
  const changed = () => { if (mounted.current) { setReload((value) => value + 1); onRefresh() } }
  return <><ToolCard items={tools} onChanged={changed} /><ApprovalCard items={approvals} onChanged={changed} /></>
}
