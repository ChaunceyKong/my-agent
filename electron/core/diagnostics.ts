import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, lstatSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { IpcChannel } from '../../shared/ipc-channels'
import type { RendererDiagnosticCode } from '../../shared/types'

export const diagnosticCodes = ['renderer_render_failed', 'renderer_unhandled_error', 'renderer_unhandled_rejection', 'ipc_failed', 'model_failed', 'startup_database_failed', 'window_load_failed', 'renderer_process_gone', 'main_uncaught_exception', 'main_unhandled_rejection', 'main_startup_failed', 'updater_failed'] as const
export type DiagnosticCode = typeof diagnosticCodes[number]
const rendererCodes: readonly string[] = diagnosticCodes.slice(0, 3)
const sources: readonly string[] = ['renderer', 'main', ...Object.values(IpcChannel)]
const dailyLimit = 64 * 1024
const filename = /^error-(\d{4}-\d{2}-\d{2})\.log$/

export function validRendererDiagnostic(value: unknown): RendererDiagnosticCode {
  if (typeof value !== 'string' || !rendererCodes.includes(value)) throw new Error('诊断请求无效')
  return value as RendererDiagnosticCode
}

export interface Diagnostics {
  record(code: DiagnosticCode, source?: string): void
  export(): Promise<{ status: 'exported' | 'cancelled' }>
}

export function createDiagnostics(options: {
  userData: string
  now?: () => Date
  showSaveDialog(): Promise<{ canceled: boolean; filePath?: string }>
}): Diagnostics {
  const directory = join(options.userData, 'logs')
  const now = options.now ?? (() => new Date())
  const day = () => now().toISOString().slice(0, 10)
  function prepare() {
    mkdirSync(directory, { recursive: true })
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe log directory')
    const earliest = new Date(`${day()}T00:00:00Z`).getTime() - 6 * 86400000
    for (const name of readdirSync(directory)) {
      const match = filename.exec(name)
      if (!match) continue
      const date = Date.parse(`${match[1]}T00:00:00Z`)
      const path = join(directory, name)
      if (Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === match[1]
        && date < earliest && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) unlinkSync(path)
    }
  }
  function record(code: DiagnosticCode, source = 'main') {
    // Synchronous bounded writes serialize without an unbounded pending queue.
    // Storage failures are deliberately not reported back into this logger.
    try {
      if (!diagnosticCodes.includes(code) || !sources.includes(source)) return
      prepare()
      const path = join(directory, `error-${day()}.log`)
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) return
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600)
      try {
        const line = JSON.stringify({ time: now().toISOString(), code, source }) + '\n'
        if (fstatSync(fd).size + Buffer.byteLength(line) <= dailyLimit) writeSync(fd, line)
      } finally { closeSync(fd) }
    } catch { /* Logging cannot recursively fail the application. */ }
  }
  async function exportLogs(): Promise<{ status: 'exported' | 'cancelled' }> {
    const selected = await options.showSaveDialog().catch(() => { throw new Error('诊断日志导出失败，请检查保存位置后重试') })
    if (selected.canceled || !selected.filePath) return { status: 'cancelled' }
    try {
      prepare()
      const output: string[] = []
      const today = Date.parse(`${day()}T00:00:00Z`)
      for (let age = 6; age >= 0; age -= 1) {
        const date = new Date(today - age * 86400000).toISOString().slice(0, 10)
        const name = `error-${date}.log`
        const path = join(directory, name)
        if (!existsSync(path)) continue
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue
        const fd = openSync(path, constants.O_RDONLY)
        let content: string
        try {
          if (!fstatSync(fd).isFile() || fstatSync(fd).size > dailyLimit) continue
          const bytes = Buffer.alloc(dailyLimit)
          content = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8')
        } finally { closeSync(fd) }
        for (const line of content.split('\n')) {
          try {
            const item = JSON.parse(line)
            if (!item || Object.keys(item).sort().join(',') !== 'code,source,time' || typeof item.time !== 'string'
              || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.time)
              || !Number.isFinite(Date.parse(item.time)) || item.time.slice(0, 10) !== date
              || !diagnosticCodes.includes(item.code) || !sources.includes(item.source)) continue
            output.push(JSON.stringify({ time: item.time, code: item.code, source: item.source }) + '\n')
          } catch { /* Untrusted local log contents are discarded. */ }
        }
      }
      const fd = openSync(selected.filePath, 'w', 0o600)
      try { writeSync(fd, output.join('')) } finally { closeSync(fd) }
      return { status: 'exported' }
    } catch { throw new Error('诊断日志导出失败，请检查保存位置后重试') }
  }
  return { record, export: exportLogs }
}
