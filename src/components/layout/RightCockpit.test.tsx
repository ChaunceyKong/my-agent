// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RightCockpit } from './RightCockpit'
import type { AgentTeamApi, Channel, TaskRun } from '../../../shared/types'

const channel: Channel = { id: 'c1', projectId: 'p', name: 'c1', icon: null, speakerMode: 'manual', maxTurns: 30, schedulerModelConfigId: null, createdAt: '', updatedAt: '' }
const run: TaskRun = { id: 'r1', channelId: 'c1', status: 'running', generation: 1, currentTurnId: 't1', turnCount: 1, modelConfigId: 'm', pauseReason: null, errorMessage: null, startedAt: '', finishedAt: null, createdAt: '' }
const pending = { id: 'a1', toolExecutionId: 'tool1', requestHash: '1'.repeat(64), status: 'pending' as const, expiresAt: '2026-10-10T00:00:00Z' }
const oldTool = { id: 'tool1', taskRunId: 'r1', toolName: 'write_file' as const, riskLevel: 'high' as const, status: 'waiting_approval' as const, resultSummary: '旧任务摘要', createdAt: '', processRecoveryRequired: false }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
let api: AgentTeamApi
const props = (changed = vi.fn()) => ({ channel, run, models: [], revision: 0, onRefresh: changed, onChannelChanged: vi.fn() })
beforeEach(() => {
  api = { agents: { list: vi.fn().mockResolvedValue([]) }, channelAgents: { list: vi.fn().mockResolvedValue([]) },
    tools: { list: vi.fn().mockResolvedValue([oldTool]) },
    approvals: { list: vi.fn().mockResolvedValue([pending]), approve: vi.fn(), reject: vi.fn(), runApproved: vi.fn() }, tasks: { acknowledgeProcessRecovery: vi.fn() },
  } as unknown as AgentTeamApi
  window.agentTeam = api
})
afterEach(cleanup)

it.each(['channel', 'generation'] as const)('remounts %s scope empty during delayed reads and rejects an old read result', async (scope) => {
  const initial = props(); const view = render(<RightCockpit {...initial} />)
  await userEvent.click(screen.getByRole('tab', { name: '工具与审批' })); expect(await screen.findByRole('button', { name: '批准' })).toBeEnabled()
  const oldRead = deferred<Awaited<ReturnType<AgentTeamApi['approvals']['list']>>>()
  vi.mocked(api.approvals.list).mockReturnValueOnce(oldRead.promise)
  view.rerender(<RightCockpit {...initial} revision={1} />)
  const nextApprovals = deferred<Awaited<ReturnType<AgentTeamApi['approvals']['list']>>>()
  const nextTools = deferred<Awaited<ReturnType<AgentTeamApi['tools']['list']>>>()
  vi.mocked(api.approvals.list).mockReturnValueOnce(nextApprovals.promise); vi.mocked(api.tools.list).mockReturnValueOnce(nextTools.promise)
  view.rerender(<RightCockpit {...initial} channel={scope === 'channel' ? { ...channel, id: 'c2' } : channel} run={scope === 'channel' ? { ...run, id: 'r2', channelId: 'c2' } : { ...run, generation: 2 }} />)
  expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument(); expect(screen.queryByText(/旧任务摘要/)).not.toBeInTheDocument()
  await act(async () => { nextApprovals.resolve([{ ...pending, id: 'a2', status: 'approved' }]); nextTools.resolve([{ ...oldTool, id: 'tool2', resultSummary: '新任务摘要' }]) })
  expect(await screen.findByRole('button', { name: '执行已批准操作' })).toBeEnabled()
  await act(async () => oldRead.resolve([pending]))
  expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument(); expect(screen.getByText(/新任务摘要/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '执行已批准操作' })); expect(api.approvals.runApproved).toHaveBeenCalledWith('a2')
})

it.each(['approve', 'reject', 'runApproved'] as const)('does not reload or display old %s completion after navigation', async (method) => {
  if (method === 'runApproved') vi.mocked(api.approvals.list).mockResolvedValue([{ ...pending, status: 'approved' }])
  const mutation = deferred<void>(); vi.mocked(api.approvals[method]).mockReturnValue(mutation.promise as never)
  const onRefresh = vi.fn(); const initial = props(onRefresh); const view = render(<RightCockpit {...initial} />)
  await userEvent.click(screen.getByRole('tab', { name: '工具与审批' }))
  await userEvent.click(await screen.findByRole('button', { name: method === 'approve' ? '批准' : method === 'reject' ? '拒绝' : '执行已批准操作' }))
  vi.mocked(api.approvals.list).mockResolvedValue([{ ...pending, id: 'new-approval' }]); vi.mocked(api.tools.list).mockResolvedValue([])
  view.rerender(<RightCockpit {...initial} channel={{ ...channel, id: 'c2' }} run={{ ...run, id: 'r2', channelId: 'c2' }} />)
  expect(await screen.findByRole('button', { name: '批准' })).toBeEnabled()
  const reads = vi.mocked(api.approvals.list).mock.calls.length
  await act(async () => mutation.resolve())
  expect(onRefresh).not.toHaveBeenCalled(); expect(api.approvals.list).toHaveBeenCalledTimes(reads); expect(screen.queryByText('已请求执行已批准操作。')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '批准' })).toBeEnabled()
})
