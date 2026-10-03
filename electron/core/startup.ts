import type { MessageBoxOptions } from 'electron'

interface StartupDependencies<T extends { close(): void }> {
  open(): T
  prepare(database: T): Promise<unknown>
  showError(options: MessageBoxOptions): Promise<{ response: number }>
  quit(): void
  recordFailure?(): void
}

export async function openStartupDatabase<T extends { close(): void }>({
  open, prepare, showError, quit, recordFailure,
}: StartupDependencies<T>): Promise<T | undefined> {
  while (true) {
    let database: T | undefined
    try {
      database = open()
      await prepare(database)
      return database
    } catch {
      recordFailure?.()
      database?.close()
      const { response } = await showError({
        type: 'error',
        title: '无法启动工作台',
        message: '无法打开本地数据，请重试或退出。',
        detail: '已有数据会保留，不会自动重置。若问题持续，请退出应用后检查数据目录的访问权限或联系支持。',
        buttons: ['重试', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (response !== 0) {
        quit()
        return undefined
      }
    }
  }
}
