export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon" aria-hidden="true">◇</span><h2>{title}</h2><p>{children}</p></div>
}
