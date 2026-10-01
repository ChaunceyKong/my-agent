import { useEffect, useRef, useState } from 'react'
import type { AgentTeamApi } from '../../../shared/types'
export function ApprovalCard({ items, onChanged }: { items: Awaited<ReturnType<AgentTeamApi['approvals']['list']>>; onChanged(): void }) {
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const act = async (id: string, operation: () => Promise<unknown>, success?: string) => {
    if (busy || !mounted.current) return
    setBusy(id); setFeedback('')
    try { await operation(); if (mounted.current && success) setFeedback(success) }
    catch { if (mounted.current) setFeedback('审批操作当前不可执行，请重新检查状态。') }
    finally { if (mounted.current) { setBusy(''); onChanged() } }
  }
  if (!items.length) return <p className="unavailable-note">没有需要审批的高风险操作。</p>
  return <section aria-label="安全审批">{items.map((item) => <div key={item.id} className="metadata-card approval-card"><strong>不可变风险请求</strong><p>状态：{item.status}；到期：{new Date(item.expiresAt).toLocaleString()}</p>{item.status === 'pending' && <div><button disabled={!!busy} onClick={() => { void act(item.id, () => window.agentTeam.approvals.approve(item.id, item.requestHash)) }}>批准</button><button disabled={!!busy} onClick={() => { void act(item.id, () => window.agentTeam.approvals.reject(item.id, item.requestHash)) }}>拒绝</button></div>}{item.status === 'approved' && <button disabled={!!busy} onClick={() => { void act(item.id, () => window.agentTeam.approvals.runApproved(item.id), '已请求执行已批准操作。') }}>执行已批准操作</button>}</div>)}{feedback && <p className="unavailable-note" role="status">{feedback}</p>}</section>
}
