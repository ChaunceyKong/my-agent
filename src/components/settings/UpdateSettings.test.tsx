// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTeamApi, UpdateStatus } from '../../../shared/types'
import { UpdateSettings } from './UpdateSettings'

const status = (state: UpdateStatus['state'], reason: UpdateStatus['reason'] = null, cancellable = false): UpdateStatus => ({ state, reason, progress: null, cancellable })
let updates: AgentTeamApi['updates']
beforeEach(() => {
  updates = { status: vi.fn().mockResolvedValue(status('idle')), check: vi.fn().mockResolvedValue(status('available')), download: vi.fn().mockResolvedValue(status('downloaded')), install: vi.fn().mockResolvedValue(status('install-pending')), cancel: vi.fn().mockResolvedValue(status('downloaded')) }
  window.agentTeam = { updates } as AgentTeamApi
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

it('only reads status automatically and requires separate explicit check, download and install clicks', async () => {
  render(<UpdateSettings />)
  await waitFor(() => expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled())
  expect(updates.status).toHaveBeenCalledWith()
  expect(updates.check).not.toHaveBeenCalled(); expect(updates.download).not.toHaveBeenCalled(); expect(updates.install).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '检查更新' }))
  expect(updates.check).toHaveBeenCalledWith()
  expect(updates.download).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '下载更新' }))
  expect(updates.download).toHaveBeenCalledWith()
  expect(updates.install).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '重启并安装更新' }))
  expect(updates.install).toHaveBeenCalledWith()
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('尚未确认安装完成')
  expect(screen.queryByRole('button', { name: '取消安装检查' })).not.toBeInTheDocument()
})

it.each(['development', 'portable', 'unsupported', 'unconfigured', 'signing-unavailable'] as const)('explains %s as unavailable without starting actions', async (reason) => {
  vi.mocked(updates.status).mockResolvedValue(status('disabled', reason))
  render(<UpdateSettings />); await settle()
  expect(screen.getByText(/不会访问更新网络/)).toBeVisible()
  for (const label of ['检查更新', '下载更新', '重启并安装更新']) expect(screen.getByRole('button', { name: label })).toBeDisabled()
  expect(updates.check).not.toHaveBeenCalled(); expect(updates.download).not.toHaveBeenCalled(); expect(updates.install).not.toHaveBeenCalled()
})

it('polls only status while downloading, clamps progress, and stops polling after completion and unmount', async () => {
  vi.useFakeTimers()
  vi.mocked(updates.status).mockResolvedValue({ ...status('downloading'), progress: 150 })
  const view = render(<UpdateSettings />); await settle()
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('100%')
  expect(vi.getTimerCount()).toBe(1)
  vi.mocked(updates.status).mockResolvedValueOnce(status('downloaded'))
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(updates.status).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
  expect(updates.install).not.toHaveBeenCalled()
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(updates.status).toHaveBeenCalledTimes(2)
})

it('disposes an active checking poll on unmount', async () => {
  vi.useFakeTimers()
  vi.mocked(updates.status).mockResolvedValue(status('checking'))
  const view = render(<UpdateSettings />); await settle()
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(vi.getTimerCount()).toBe(0)
  expect(updates.status).toHaveBeenCalledTimes(1)
  expect(updates.check).not.toHaveBeenCalled()
})

it('allows cancelling only pre-install checks, not an already handed-off installer', async () => {
  vi.mocked(updates.status).mockResolvedValue(status('install-pending', null, true))
  render(<UpdateSettings />); await settle()
  await userEvent.click(screen.getByRole('button', { name: '取消安装检查' }))
  expect(updates.cancel).toHaveBeenCalledWith()
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('等待你确认重启安装')
  expect(screen.queryByRole('button', { name: '取消安装检查' })).not.toBeInTheDocument()
  expect(updates.install).not.toHaveBeenCalled()
})

it('reads pending preflight concurrently, permits explicit cancel and ignores the old install result', async () => {
  vi.mocked(updates.status).mockResolvedValue(status('downloaded'))
  let resolve!: (next: UpdateStatus) => void
  vi.mocked(updates.install).mockImplementation(() => {
    vi.mocked(updates.status).mockResolvedValue(status('install-pending', null, true))
    return new Promise((done) => { resolve = done })
  })
  render(<UpdateSettings />); await settle()
  await userEvent.click(screen.getByRole('button', { name: '重启并安装更新' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '取消安装检查' })).toBeEnabled())
  expect(screen.getByRole('button', { name: '重启并安装更新' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: '取消安装检查' }))
  expect(updates.cancel).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('等待你确认重启安装')
  await act(async () => { resolve(status('install-pending')); await Promise.resolve() })
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('等待你确认重启安装')
  expect(updates.install).toHaveBeenCalledTimes(1)
})

it.each(['busy', 'barriers'] as const)('explains %s without terminating or replaying work', async (reason) => {
  vi.mocked(updates.status).mockResolvedValue(status('downloaded', reason))
  render(<UpdateSettings />); await settle()
  expect(screen.getByText(/不会为安装终止任务/)).toBeVisible()
  expect(updates.install).not.toHaveBeenCalled(); expect(updates.cancel).not.toHaveBeenCalled()
})

it('does not present uncertain handoff as installed or cancellable and stops polling', async () => {
  vi.useFakeTimers()
  vi.mocked(updates.status).mockResolvedValue(status('install-pending', 'handoff-unconfirmed'))
  render(<UpdateSettings />); await settle()
  expect(screen.getByText(/关闭或重新启动应用前，请检查数据/)).toBeVisible()
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('尚未确认安装完成')
  expect(screen.queryByRole('button', { name: '取消安装检查' })).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(updates.status).toHaveBeenCalledTimes(1)
  expect(updates.install).not.toHaveBeenCalled()
})

it('shows fixed errors and permits status retry without displaying raw updater errors', async () => {
  vi.mocked(updates.status).mockRejectedValueOnce(new Error('private URL https://private.test/token'))
  render(<UpdateSettings />); await settle()
  expect(screen.getByRole('alert')).toHaveTextContent('请稍后手动重试')
  expect(screen.queryByText(/private/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '重新读取更新状态' }))
  expect(screen.getByRole('button', { name: '检查更新' })).toBeEnabled()
  vi.mocked(updates.check).mockRejectedValueOnce(new Error('private updater response'))
  await userEvent.click(screen.getByRole('button', { name: '检查更新' }))
  expect(screen.getByRole('alert')).not.toHaveTextContent('private')
})

it('fences late status results under StrictMode and after unmount without further polling', async () => {
  vi.useFakeTimers()
  let resolve!: (next: UpdateStatus) => void
  vi.mocked(updates.status).mockReturnValueOnce(new Promise((done) => { resolve = done }))
  const view = render(<StrictMode><UpdateSettings /></StrictMode>); await settle()
  expect(screen.getByLabelText('更新状态')).toHaveTextContent('尚未检查更新')
  view.unmount()
  await act(async () => { resolve(status('downloading')); await vi.advanceTimersByTimeAsync(2000) })
  expect(updates.status).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
