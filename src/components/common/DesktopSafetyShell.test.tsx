// @vitest-environment jsdom
import { cleanup, render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTeamApi } from '../../../shared/types'
import { DesktopSafetyShell, DiagnosticExport } from './DesktopSafetyShell'

const diagnostics: AgentTeamApi['diagnostics'] = { report: vi.fn(), export: vi.fn() }
beforeEach(() => {
  vi.mocked(diagnostics.report).mockReset().mockResolvedValue(undefined)
  vi.mocked(diagnostics.export).mockReset().mockResolvedValue({ status: 'cancelled' })
  window.agentTeam = { diagnostics } as AgentTeamApi
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('catches an actual rendering exception, reports no payload and only reloads UI', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const reload = vi.fn()
  const send = vi.fn(); const resume = vi.fn(); const cancel = vi.fn()
  window.agentTeam.tasks = { send, continue: resume, cancel } as unknown as AgentTeamApi['tasks']
  function Broken(): JSX.Element { throw new Error('secret-key /private/workspace prompt') }
  render(<DesktopSafetyShell reload={reload}><Broken /></DesktopSafetyShell>)
  expect(screen.getByRole('heading', { name: '界面出现意外错误' })).toBeVisible()
  expect(screen.queryByText(/secret-key/)).not.toBeInTheDocument()
  expect(diagnostics.report).toHaveBeenCalledWith('renderer_render_failed')
  expect(vi.mocked(diagnostics.report).mock.calls.every((args) => args.length === 1)).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '重新加载界面' }))
  expect(reload).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
  expect(screen.getByText(/主进程中的任务可能仍在运行/)).toBeVisible()
})

it('reports fixed codes once per mounted code and survives rejected or throwing reporting', async () => {
  vi.mocked(diagnostics.report).mockRejectedValueOnce(new Error('private error')).mockImplementationOnce(() => { throw new Error('private error') })
  render(<DesktopSafetyShell><button>本地操作</button></DesktopSafetyShell>)
  await act(async () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'private prompt', error: new Error('private stack') }))
    window.dispatchEvent(new Event('unhandledrejection'))
    window.dispatchEvent(new ErrorEvent('error'))
    window.dispatchEvent(new Event('unhandledrejection'))
  })
  expect(diagnostics.report).toHaveBeenCalledTimes(2)
  expect(diagnostics.report).toHaveBeenNthCalledWith(1, 'renderer_unhandled_error')
  expect(diagnostics.report).toHaveBeenNthCalledWith(2, 'renderer_unhandled_rejection')
  expect(screen.getByRole('alert')).not.toHaveTextContent('private')
  expect(screen.getByRole('button', { name: '本地操作' })).toBeEnabled()
})

it('removes global listeners on unmount, including connectivity listeners', () => {
  const remove = vi.spyOn(window, 'removeEventListener')
  const view = render(<DesktopSafetyShell><p>content</p></DesktopSafetyShell>)
  view.unmount()
  for (const name of ['error', 'unhandledrejection', 'online', 'offline']) expect(remove).toHaveBeenCalledWith(name, expect.any(Function))
  window.dispatchEvent(new ErrorEvent('error'))
  expect(diagnostics.report).not.toHaveBeenCalled()
})

it('shows an offline hint without disabling local or Ollama controls and clears on online', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  render(<DesktopSafetyShell><button>本地操作</button><button>Ollama</button></DesktopSafetyShell>)
  expect(screen.getByRole('status')).toHaveTextContent('不代表模型服务不可用')
  expect(screen.getByRole('button', { name: '本地操作' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Ollama' })).toBeEnabled()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  act(() => { window.dispatchEvent(new Event('online')) })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  act(() => { window.dispatchEvent(new Event('offline')) })
  expect(screen.getByRole('status')).toBeVisible()
})

it('exports explicitly and treats cancellation and errors as controlled notices', async () => {
  render(<DiagnosticExport />)
  expect(diagnostics.export).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '导出诊断日志' }))
  expect(diagnostics.export).toHaveBeenCalledWith()
  expect(screen.getByRole('status')).toHaveTextContent('已取消导出')
  vi.mocked(diagnostics.export).mockRejectedValueOnce(new Error('api-key absolute path'))
  await userEvent.click(screen.getByRole('button', { name: '导出诊断日志' }))
  expect(screen.getByRole('status')).toHaveTextContent('确认保存位置可写')
  expect(screen.queryByText(/api-key/)).not.toBeInTheDocument()
  expect(diagnostics.report).not.toHaveBeenCalled()
  vi.mocked(diagnostics.export).mockResolvedValueOnce({ status: 'exported' })
  await userEvent.click(screen.getByRole('button', { name: '导出诊断日志' }))
  expect(screen.getByRole('status')).toHaveTextContent('诊断日志已导出')
})
