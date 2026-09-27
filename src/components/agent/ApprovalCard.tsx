import { useState } from 'react'
import type { AgentTeamApi } from '../../../shared/types'
export function ApprovalCard({ items, onChanged }: { items: Awaited<ReturnType<AgentTeamApi['approvals']['list']>>; onChanged(): void }) {
  const [busy, setBusy] = useState('')
  if (!items.length) return <p className="unavailable-note">没有需要审批的高风险操作。</p>
  return <section aria-label="安全审批">{items.map((item) => <div key={item.id} className="metadata-card approval-card"><strong>不可变风险请求</strong><p>状态：{item.status}；到期：{new Date(item.expiresAt).toLocaleString()}</p>{item.status === 'pending' && <div><button disabled={!!busy} onClick={async () => { setBusy(item.id); try { await window.agentTeam.approvals.approve(item.id, item.requestHash) } finally { setBusy(''); onChanged() } }}>批准</button><button disabled={!!busy} onClick={async () => { setBusy(item.id); try { await window.agentTeam.approvals.reject(item.id, item.requestHash) } finally { setBusy(''); onChanged() } }}>拒绝</button></div>}</div>)}</section>
}
