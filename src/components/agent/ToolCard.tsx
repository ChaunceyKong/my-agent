import type { AgentTeamApi } from '../../../shared/types'
export function ToolCard({ items }: { items: Awaited<ReturnType<AgentTeamApi['tools']['list']>> }) {
  if (!items.length) return <p className="unavailable-note">当前任务尚未使用工具。</p>
  return <section aria-label="工具执行记录">{items.map((item) => <div key={item.id} className="metadata-card tool-card"><strong>{item.toolName}</strong><span>{item.status}</span><p>安全摘要：{item.resultSummary ?? '执行中，详细参数不会显示'}</p></div>)}</section>
}
