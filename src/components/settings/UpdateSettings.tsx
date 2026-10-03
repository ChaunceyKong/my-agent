import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateStatus } from '../../../shared/types'

const stateText: Record<UpdateStatus['state'], string> = {
  disabled: '自动更新不可用', idle: '尚未检查更新', checking: '正在检查更新', available: '有可下载的更新', current: '当前已是最新版本',
  downloading: '正在下载更新', downloaded: '更新已下载，等待你确认重启安装', 'install-pending': '正在准备或交接安装，尚未确认安装完成', error: '更新操作未完成',
}
const reasonText: Record<Exclude<UpdateStatus['reason'], null>, string> = {
  development: '开发环境不检查更新，不会访问更新网络。', portable: '便携版本不支持自动更新，不会访问更新网络。',
  unsupported: '当前平台不支持此更新方式，不会访问更新网络。', unconfigured: '尚未配置受信任的发布源，不会访问更新网络。',
  'signing-unavailable': '缺少签名验证配置，不会访问更新网络。', busy: '已有操作正在处理，请稍后检查；不会为安装终止任务。',
  barriers: '任务、进程、审批或文件恢复仍需处理，请先检查并完成清理；不会为安装终止任务。', failed: '请检查更新条件后手动重试。',
  'handoff-unconfirmed': '安装交接未确认。关闭或重新启动应用前，请检查数据、任务与进程状态；不要假定安装成功或任务已恢复。',
}

export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [actionName, setActionName] = useState<string | null>(null)
  const [error, setError] = useState('')
  const lifecycle = useRef(0)
  const inFlight = useRef<number | null>(null)
  const reading = useRef<number | null>(null)
  const actionVersion = useRef(0)
  const busy = actionName !== null
  const request = useCallback(async (action: keyof typeof window.agentTeam.updates) => {
    const version = lifecycle.current
    const read = action === 'status'
    if (read ? reading.current === version : action !== 'cancel' && inFlight.current !== null) return
    const revision = read ? actionVersion.current : ++actionVersion.current
    if (read) reading.current = version
    else { inFlight.current = revision; setActionName(action) }
    setError('')
    try {
      const next = await window.agentTeam.updates[action]()
      if (lifecycle.current === version && actionVersion.current === revision) {
        if (!read) actionVersion.current++
        setStatus(next)
      }
    } catch {
      if (lifecycle.current === version && actionVersion.current === revision) {
        if (!read) actionVersion.current++
        setError('更新状态读取或操作失败，请稍后手动重试。')
      }
    }
    finally {
      if (lifecycle.current === version) {
        if (read) reading.current = null
        else if (inFlight.current === revision) { inFlight.current = null; setActionName(null) }
      }
    }
  }, [])
  useEffect(() => {
    lifecycle.current++; void request('status')
    return () => { lifecycle.current++ }
  }, [request])
  useEffect(() => {
    if (status?.reason === 'handoff-unconfirmed' || (!busy && (!status || !['checking', 'downloading', 'install-pending'].includes(status.state)))) return
    if (busy) void request('status')
    const timer = setInterval(() => { void request('status') }, 1000)
    return () => clearInterval(timer)
  }, [status?.state, status?.reason, busy, request])
  const unconfirmed = status?.reason === 'handoff-unconfirmed'
  const checkAllowed = status && ['idle', 'current', 'error'].includes(status.state) && !unconfirmed
  return <section className="update-settings" aria-label="应用更新"><h3>应用更新</h3><p aria-live="polite" aria-label="更新状态">{status ? stateText[status.state] : '正在读取更新状态'}{status?.state === 'downloading' && status.progress !== null ? `（${Math.round(Math.max(0, Math.min(100, status.progress)))}%）` : ''}</p>
    {status?.reason && <p className="form-note">{reasonText[status.reason]}</p>}
    <p className="form-note">仅在你点击后检查、下载或重启安装。安装前会核验任务与清理状态；请先保存界面中的未发送输入。已交接的安装器不能在此撤销。</p>
    {error && <div className="error-card" role="alert">{error}<button type="button" disabled={busy} onClick={() => { void request('status') }}>重新读取更新状态</button></div>}
    <div className="update-actions"><button type="button" disabled={busy || !checkAllowed} onClick={() => { void request('check') }}>检查更新</button><button type="button" disabled={busy || status?.state !== 'available' || unconfirmed} onClick={() => { void request('download') }}>下载更新</button><button type="button" disabled={busy || status?.state !== 'downloaded' || unconfirmed} onClick={() => { void request('install') }}>重启并安装更新</button>{status?.state === 'install-pending' && status.cancellable && !unconfirmed && <button type="button" disabled={actionName === 'cancel'} onClick={() => { void request('cancel') }}>取消安装检查</button>}</div>
  </section>
}
