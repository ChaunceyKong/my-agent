import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDiagnostics, validRendererDiagnostic } from '../../electron/core/diagnostics'
import { createFatalHandler } from '../../electron/core/fatal-errors'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import type { Repositories } from '../../electron/database/repositories'
import { IpcChannel } from '../../shared/ipc-channels'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'diagnostics-'))
  roots.push(root)
  const output = join(root, 'export.log')
  const showSaveDialog = vi.fn().mockResolvedValue({ canceled: false, filePath: output })
  const diagnostics = createDiagnostics({ userData: root, now: () => new Date('2026-10-02T12:00:00.000Z'), showSaveDialog })
  return { root, output, showSaveDialog, diagnostics, directory: join(root, 'logs') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('writes only fixed codes and sources; drops arbitrary secrets and bounds one day', () => {
  const { directory, diagnostics } = fixture()
  diagnostics.record('ipc_failed', IpcChannel.ModelSave)
  diagnostics.record('PRIVATE_API_KEY' as never)
  diagnostics.record('ipc_failed', 'PRIVATE_PATH')
  for (let n = 0; n < 2000; n++) diagnostics.record('model_failed')
  const path = join(directory, 'error-2026-10-02.log')
  expect(statSync(path).size).toBeLessThanOrEqual(64 * 1024)
  expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE')
  const first = JSON.parse(readFileSync(path, 'utf8').split('\n')[0])
  expect(first).toEqual({ time: '2026-10-02T12:00:00.000Z', code: 'ipc_failed', source: 'model:save' })
})

it('retains seven UTC dates and never touches unrelated files or directories', async () => {
  const { directory, diagnostics, output } = fixture()
  mkdirSync(directory)
  const record = (date: string) => JSON.stringify({ time: `${date}T00:00:00.000Z`, code: 'ipc_failed', source: 'main' }) + '\n'
  for (const date of ['2026-09-25', '2026-09-26', '2026-10-02', '2026-10-03', '2026-99-99']) writeFileSync(join(directory, `error-${date}.log`), record(date))
  writeFileSync(join(directory, 'notes.txt'), 'PRIVATE_USER_FILE')
  mkdirSync(join(directory, 'error-2026-09-24.log'))
  diagnostics.record('model_failed')
  expect(readdirSync(directory)).not.toContain('error-2026-09-25.log')
  expect(readFileSync(join(directory, 'notes.txt'), 'utf8')).toBe('PRIVATE_USER_FILE')
  await diagnostics.export()
  expect(readFileSync(output, 'utf8')).toContain('2026-09-26')
  expect(readFileSync(output, 'utf8')).not.toMatch(/2026-10-03|2026-99-99|PRIVATE/)
})

it('reconstructs strict allowed records and excludes locally injected content and oversized files', async () => {
  const { directory, diagnostics, output } = fixture()
  diagnostics.record('renderer_render_failed', 'renderer')
  const path = join(directory, 'error-2026-10-02.log')
  const valid = readFileSync(path, 'utf8')
  const base = JSON.parse(valid)
  writeFileSync(path, valid + [
    { ...base, stack: 'PRIVATE_PROMPT' }, { ...base, code: 'PRIVATE_KEY' }, { ...base, source: 'PRIVATE_ROOT' },
    { ...base, time: 'PRIVATE_TOOL_CONTENT' }, { ...base, time: '2026-10-01T12:00:00.000Z' },
  ].map((item) => JSON.stringify(item)).join('\n') + '\nRAW_PRIVATE_BODY\n')
  writeFileSync(join(directory, 'error-2026-10-01.log'), 'PRIVATE'.repeat(10000))
  expect(await diagnostics.export()).toEqual({ status: 'exported' })
  expect(readFileSync(output, 'utf8')).toBe(valid)
})

it('cancelled export performs no output writes and failures remain controlled', async () => {
  const { diagnostics, showSaveDialog, output, root } = fixture()
  showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: output })
  expect(await diagnostics.export()).toEqual({ status: 'cancelled' })
  expect(readdirSync(root)).not.toContain('export.log')
  showSaveDialog.mockRejectedValueOnce(new Error('PRIVATE_DIALOG_PATH'))
  await expect(diagnostics.export()).rejects.toThrow('诊断日志导出失败')
  showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: root })
  await expect(diagnostics.export()).rejects.toThrow('诊断日志导出失败')
})

it('logging failure never crashes and strict Renderer reporting rejects free-form payloads', () => {
  const { root, diagnostics } = fixture()
  writeFileSync(join(root, 'logs'), 'not a directory')
  expect(() => diagnostics.record('model_failed')).not.toThrow()
  for (const invalid of [{ code: 'renderer_render_failed', error: 'PRIVATE' }, 'PRIVATE', null, 12]) expect(() => validRendererDiagnostic(invalid)).toThrow('诊断请求无效')
  expect(validRendererDiagnostic('renderer_render_failed')).toBe('renderer_render_failed')
})

it('wraps synchronous and asynchronous IPC failures while retaining existing error behavior', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => any>()
  const record = vi.fn()
  registerHandlers({ ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    dialog: { showOpenDialog: vi.fn() }, repositories: { listProjects: async () => { throw new Error('PRIVATE_SQL') } } as unknown as Repositories,
    diagnostics: { record, export: vi.fn().mockResolvedValue({ status: 'cancelled' }) } })
  expect(() => handlers.get(IpcChannel.DiagnosticsReport)!({}, 'renderer_render_failed', { secret: 'PRIVATE' })).toThrow('诊断请求无效')
  expect(() => handlers.get(IpcChannel.DiagnosticsExport)!({}, 'PRIVATE_PATH')).toThrow('诊断请求无效')
  handlers.get(IpcChannel.DiagnosticsReport)!({}, 'renderer_render_failed')
  await expect(handlers.get(IpcChannel.ProjectList)!({})).rejects.toThrow('PRIVATE_SQL')
  expect(record.mock.calls).toEqual([
    ['ipc_failed', 'diagnostics:report'], ['ipc_failed', 'diagnostics:export'],
    ['renderer_render_failed', 'renderer'], ['ipc_failed', 'project:list'],
  ])
  expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE')
})

it('fatal failures exit only once even when logging or dialog fails', () => {
  const exit = vi.fn()
  const record = vi.fn(() => { throw new Error('PRIVATE') })
  const showError = vi.fn(() => { throw new Error('PRIVATE') })
  const fatal = createFatalHandler({ record, showError, exit })
  fatal('main_uncaught_exception'); fatal('main_unhandled_rejection')
  expect(record).toHaveBeenCalledTimes(1)
  expect(showError).toHaveBeenCalledTimes(1)
  expect(exit).toHaveBeenCalledTimes(1)
})
