import { useEffect, useRef, useState } from 'react'
import type { AgentTeamApi } from '../../../shared/types'
export function ToolCard({ items, onChanged }: { items: Awaited<ReturnType<AgentTeamApi['tools']['list']>>; onChanged(): void }) {
  if (!items.length) return <p className="unavailable-note">当前任务尚未使用工具。</p>
  return <section aria-label="工具执行记录">{items.map((item) => <div key={item.id} className="metadata-card tool-card"><strong>{item.toolName}</strong><span>{item.status}</span><p>安全摘要：{item.resultSummary ?? '执行中，详细参数不会显示'}</p>{item.processRecoveryRequired && <ProcessRecovery item={item} onChanged={onChanged} />}</div>)}</section>
}

function ProcessRecovery({ item, onChanged }: { item: Awaited<ReturnType<AgentTeamApi['tools']['list']>>[number]; onChanged(): void }) {
  const [checked, setChecked] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  return <div className="process-recovery"><p>应用无法确认遗留进程已停止。请先在系统中人工停止相关进程，并核验该操作没有继续改动工作目录。勾选确认只登记核验结果，不会代你终止进程。</p><label><input type="checkbox" checked={checked} disabled={busy} onChange={(event) => setChecked(event.target.checked)} />我已人工停止并核验遗留进程</label><button disabled={!checked || busy} onClick={async () => {
    if (!mounted.current || busy) return
    setBusy(true); setError('')
    try { await window.agentTeam.tasks.acknowledgeProcessRecovery(item.taskRunId, item.id, 'manually_stopped_and_verified'); if (mounted.current) onChanged() }
    catch { if (mounted.current) setError('核验登记失败，请等待清理完成后重试') } finally { if (mounted.current) setBusy(false) }
  }}>登记人工核验</button>{error && <p role="alert">{error}</p>}</div>
}
