import { useEffect, useState } from 'react'
import type { Channel, DirectoryEntry } from '../../../shared/types'
export function WorkspaceTree({ channel }: { channel?: Channel }) {
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { if (!channel) { setEntries(null); return }; setEntries(null); setError(''); void window.agentTeam.workspace.list(channel.id, '.').then((result) => setEntries(result.entries)).catch(() => setError('工作区当前不可用或不允许读取。')) }, [channel?.id])
  if (!channel) return <p className="unavailable-note">选择群聊后显示安全工作区目录。</p>
  if (error) return <p className="unavailable-note">{error}</p>
  if (!entries) return <p className="unavailable-note">正在读取安全目录…</p>
  return <ul className="workspace-tree" aria-label="安全工作区文件">{entries.map((entry) => <li key={entry.path}>{entry.type === 'directory' ? '📁' : '📄'} {entry.path}</li>)}</ul>
}
