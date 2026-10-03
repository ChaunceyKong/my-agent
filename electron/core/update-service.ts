import type { UpdateStatus } from '../../shared/types'
import type { ExecutionGate } from './execution-gate'

export interface UpdateAdapter {
  check(): Promise<boolean>
  download(): Promise<void>
  /** False means no installer handoff and no quit scheduled. True is not installation success. */
  install(): boolean
  onProgress(listener: (percent: number) => void): void
  onError(listener: () => void): void
  onQuitCancelled(listener: () => void): void
}

export function createUpdateService(options: {
  gate: ExecutionGate
  disabledReason?: UpdateStatus['reason']
  adapter?: UpdateAdapter
  hasBarriers(): Promise<boolean>
  hasEffects(): boolean
  recordFailure?(): void
}) {
  let state: UpdateStatus = { state: options.disabledReason ? 'disabled' : 'idle', reason: options.disabledReason ?? null, progress: null, cancellable: false }
  let action = false
  let adapterAction = false
  let epoch = 0
  let handedOff = false
  let release: (() => void) | undefined
  const status = (): UpdateStatus => ({ ...state })
  function failed() {
    options.recordFailure?.()
    if (handedOff) { state = { state: 'install-pending', reason: 'handoff-unconfirmed', progress: null, cancellable: false }; return }
    release?.(); release = undefined
    state = { state: 'error', reason: 'failed', progress: null, cancellable: false }
  }
  options.adapter?.onProgress((percent) => {
    if (state.state === 'downloading' && Number.isFinite(percent)) state.progress = Math.max(0, Math.min(100, percent))
  })
  options.adapter?.onError(() => { if (adapterAction || handedOff) failed() })
  options.adapter?.onQuitCancelled(() => { if (handedOff) failed() })
  function available() {
    if (state.state === 'disabled') return false
    if (!options.adapter) throw new Error('更新服务不可用。')
    if (action || handedOff) throw new Error('更新操作正在执行，请稍后重试。')
    return true
  }
  return {
    status,
    async check(): Promise<UpdateStatus> {
      if (!available()) return status()
      action = true; adapterAction = true; state = { state: 'checking', reason: null, progress: null, cancellable: false }
      try {
        const found = await options.adapter!.check()
        if (state.state === 'checking') state = { state: found ? 'available' : 'current', reason: null, progress: null, cancellable: false }
      } catch { failed() } finally { action = false; adapterAction = false }
      return status()
    },
    async download(): Promise<UpdateStatus> {
      if (!available()) return status()
      if (state.state !== 'available') throw new Error('请先检查可用更新。')
      action = true; adapterAction = true; state = { state: 'downloading', reason: null, progress: 0, cancellable: false }
      try {
        await options.adapter!.download()
        if (state.state === 'downloading') state = { state: 'downloaded', reason: null, progress: 100, cancellable: false }
      } catch { failed() } finally { action = false; adapterAction = false }
      return status()
    },
    async install(): Promise<UpdateStatus> {
      if (!available()) return status()
      if (state.state !== 'downloaded') throw new Error('请先显式下载更新。')
      try { release = options.gate.beginInstall() } catch {
        state = { state: 'downloaded', reason: 'busy', progress: 100, cancellable: false }
        return status()
      }
      action = true
      const token = ++epoch
      state = { state: 'install-pending', reason: null, progress: null, cancellable: true }
      try {
        const barriers = await options.hasBarriers()
        if (token !== epoch) return status()
        if (barriers || options.hasEffects()) {
          release?.(); release = undefined
          state = { state: 'downloaded', reason: 'barriers', progress: 100, cancellable: false }
          return status()
        }
        state.cancellable = false
        // Error can be emitted synchronously by install(). Delay failure cleanup until its
        // boolean result proves whether quit/external installer work was already scheduled.
        handedOff = true
        const accepted = options.adapter!.install()
        if (!accepted) { handedOff = false; failed() }
      } catch { if (token === epoch) failed() } finally { if (token === epoch) action = false }
      return status()
    },
    async cancel(): Promise<UpdateStatus> {
      if (state.state === 'disabled') return status()
      if (handedOff || !state.cancellable) throw new Error('更新已交接或当前操作不可取消，请检查更新状态。')
      epoch++; action = false; release?.(); release = undefined
      state = { state: 'downloaded', reason: null, progress: 100, cancellable: false }
      return status()
    },
  }
}
export type UpdateService = ReturnType<typeof createUpdateService>
