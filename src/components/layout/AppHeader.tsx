import type { Channel, ProjectSummary } from '../../../shared/types'
import { useTheme, type ThemePreference } from '../../theme'

export function AppHeader({ project, channel, cockpitOpen, onToggle }: { project?: ProjectSummary; channel?: Channel; cockpitOpen: boolean; onToggle(): void }) {
  const { preference, selectTheme } = useTheme()
  return <header className="app-header"><div className="brand"><span className="brand-mark">⚡</span><strong>Agent Team Desktop</strong></div><div className="breadcrumbs"><span>{project?.name ?? '尚未选择项目'}</span><span aria-hidden="true">/</span><span>{channel?.name ?? '开始协作'}</span></div><span className="workspace-badge">{project ? '已绑定本地目录' : '本地工作台'}</span><select className="theme-picker" aria-label="界面主题" value={preference} onChange={(event) => selectTheme(event.target.value as ThemePreference)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select><button className="icon-button" aria-label={cockpitOpen ? '收起右侧面板' : '展开右侧面板'} aria-expanded={cockpitOpen} aria-controls="right-cockpit" onClick={onToggle}>▥</button></header>
}
