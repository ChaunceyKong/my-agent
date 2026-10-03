/** Main-owned admission fence. Reservations are synchronous, before the first await. */
export function createExecutionGate() {
  let active = 0
  let pending = false
  const blocked = () => new Error('更新安装正在准备或等待退出，请稍后重试。')
  function reserve() {
    if (pending) throw blocked()
    active++
    let released = false
    return () => { if (!released) { released = true; active-- } }
  }
  return {
    reserve,
    protect<T extends (...args: any[]) => Promise<any>>(operation: T): T {
      return (async (...args: Parameters<T>) => {
        const release = reserve()
        try { return await operation(...args) } finally { release() }
      }) as T
    },
    beginInstall() {
      if (pending) throw blocked()
      if (active) throw new Error('仍有操作正在执行，请等待完成后再安装更新。')
      pending = true
      let released = false
      return () => { if (!released) { released = true; pending = false } }
    },
    isPending: () => pending,
    hasReservations: () => active > 0,
  }
}
export type ExecutionGate = ReturnType<typeof createExecutionGate>
