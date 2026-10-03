import { Component, useEffect, useState, type ReactNode } from 'react'

type ReportCode = 'renderer_render_failed' | 'renderer_unhandled_error' | 'renderer_unhandled_rejection'

function report(code: ReportCode): void {
  try { void window.agentTeam.diagnostics.report(code).catch(() => {}) } catch { /* Reporting must never trigger another global error. */ }
}

export function DiagnosticExport() {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  return <div className="diagnostic-export"><button type="button" disabled={busy} onClick={async () => {
    if (busy) return; setBusy(true); setNotice('')
    try { const result = await window.agentTeam.diagnostics.export(); setNotice(result.status === 'exported' ? '诊断日志已导出' : '已取消导出') }
    catch { setNotice('诊断日志导出失败，请确认保存位置可写后重试。') }
    finally { setBusy(false) }
  }}>导出诊断日志</button><p className="form-note">日志仅含受控诊断代码，不包含对话、密钥或工作目录内容。</p>{notice && <p role="status" className="form-note">{notice}</p>}</div>
}

function Recovery({ reload }: { reload(): void }) {
  return <><p>主进程中的任务可能仍在运行。重新加载仅恢复界面，不会自动继续、重发或取消任务；请重新检查任务与审批状态。</p><button type="button" onClick={reload}>重新加载界面</button></>
}

class RenderBoundary extends Component<{ children: ReactNode; reload(): void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { report('renderer_render_failed') }
  render() {
    if (this.state.failed) return <main className="desktop-unavailable"><section className="error-card" role="alert"><h1>界面出现意外错误</h1><Recovery reload={this.props.reload} /><DiagnosticExport /></section></main>
    return this.props.children
  }
}

export function DesktopSafetyShell({ children, reload = () => window.location.reload() }: { children: ReactNode; reload?: () => void }) {
  const [unexpected, setUnexpected] = useState(false)
  const [offline, setOffline] = useState(() => !navigator.onLine)
  useEffect(() => {
    const reported = new Set<ReportCode>()
    const unexpectedError = (code: ReportCode) => {
      setUnexpected(true)
      if (!reported.has(code)) { reported.add(code); report(code) }
    }
    const error = () => unexpectedError('renderer_unhandled_error')
    const rejection = () => unexpectedError('renderer_unhandled_rejection')
    const connectivity = () => setOffline(!navigator.onLine)
    window.addEventListener('error', error)
    window.addEventListener('unhandledrejection', rejection)
    window.addEventListener('online', connectivity)
    window.addEventListener('offline', connectivity)
    return () => {
      window.removeEventListener('error', error)
      window.removeEventListener('unhandledrejection', rejection)
      window.removeEventListener('online', connectivity)
      window.removeEventListener('offline', connectivity)
    }
  }, [])
  return <div className="desktop-safety-shell">{offline && <div className="connectivity-hint" role="status">浏览器报告网络离线。此提示不代表模型服务不可用，本地操作和 Ollama 仍可使用。</div>}{unexpected && <div className="global-error-notice error-card" role="alert"><strong>界面发生意外错误，请检查任务状态后再操作。</strong><Recovery reload={reload} /></div>}<RenderBoundary reload={reload}>{children}</RenderBoundary></div>
}
