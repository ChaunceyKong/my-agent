import { useState } from 'react'
import type { Conversation, WorkbenchStore } from '../../stores/workbench-store'

export function TaskControls({ conversation, store, busy }: { conversation: Conversation; store: WorkbenchStore; busy: boolean }) {
  const [agentId, setAgentId] = useState('')
  const run = conversation.runs.find((item) => ['running', 'paused', 'cancelling'].includes(item.status))
  if (!run) return null
  const turn = conversation.turns.find((item) => item.id === run.currentTurnId)
  const speaker = conversation.agents.find((item) => item.id === turn?.agentId)
  const canResume = conversation.resumeAllowed[run.id] === true
  const waiting = turn?.status === 'waiting_approval' && !canResume
  const active = turn?.status === 'running'
  const members = conversation.agents.filter((agent) => conversation.members.some((member) => member.agentId === agent.id && member.isEnabled))
  const reason = conversation.events.filter((event) => event.taskRunId === run.id && event.eventType === 'speaker_decided' && event.displayReason).at(-1)?.displayReason
  return <section className="task-controls" aria-label="CEO 任务控制"><div className="task-summary"><strong>{waiting ? '等待 CEO 审批' : turn?.status === 'waiting_approval' ? '审批已处理，可继续任务' : run.status === 'cancelling' ? '正在安全停止' : active ? `当前发言：${speaker?.name ?? 'Agent'}` : run.status === 'paused' ? '任务已暂停' : '正在安排发言'}</strong><span>已启动 {run.turnCount} 轮</span></div>{reason && <p className="form-note">调度理由：{reason}</p>}{waiting && <p className="form-note" role="alert">工具操作正在等待 CEO 审批。请在“工具与审批”批准并执行或拒绝，再明确继续；期间下一位 Agent 不会发言。</p>}{run.status === 'paused' && <p className="form-note">{run.pauseReason ?? '任务已暂停'}。恢复不会重放已执行工具；请核对记录后明确继续或指派成员。</p>}<div className="task-actions"><button disabled={busy || !canResume} onClick={() => { void store.continue() }}>继续当前任务</button><select aria-label="下一位 Agent" value={members.some((agent) => agent.id === agentId) ? agentId : ''} disabled={busy || !canResume} onChange={(event) => setAgentId(event.target.value)}><option value="">选择下一位 Agent</option>{members.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><button disabled={busy || !canResume || !members.some((agent) => agent.id === agentId)} onClick={() => { void store.assign(agentId) }}>指派并继续</button><button className="stop-button" disabled={busy || run.status === 'cancelling'} onClick={() => { void store.terminate() }}>结束当前任务</button><button className="text-button" onClick={() => { void store.refreshChannel() }}>刷新任务状态</button></div></section>
}
