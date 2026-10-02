// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { ApprovalCard } from './components/agent/ApprovalCard'
import { ToolCard } from './components/agent/ToolCard'
import type { AgentSummary, AgentTeamApi, AgentTurn, Channel, ChannelTaskSnapshot, Message, StreamEvent, TaskRun } from '../shared/types'

const project = { id: 'p1', name: '内容矩阵', icon: null, createdAt: '', updatedAt: '' }
const channel: Channel = { id: 'c1', projectId: 'p1', name: '主线任务协同群', icon: null, speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null, createdAt: '', updatedAt: '' }
const model = { id: 'm1', providerPreset: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-chat', hasApiKey: true }
const agent: AgentSummary = { id: 'a1', name: '规划师', avatar: '🧭', title: '规划', modelConfigId: 'm1', defaultToolPermissions: {}, isBuiltin: false, createdAt: '', updatedAt: '' }
const run = (overrides: Partial<TaskRun> = {}): TaskRun => ({ id: 'run-1', channelId: 'c1', modelConfigId: 'm1', status: 'running', generation: 0, currentTurnId: null, turnCount: 0, pauseReason: null, createdAt: '', startedAt: null, finishedAt: null, errorMessage: null, ...overrides })
const turn = (overrides: Partial<AgentTurn> = {}): AgentTurn => ({ id: 'turn-1', taskRunId: 'run-1', ordinal: 1, agentId: 'a1', generation: 0, status: 'running', triggerEventSeq: 1, messageId: null, startedAt: '', finishedAt: null, ...overrides })
const reply = (content: string, overrides: Partial<Message> = {}): Message => ({ id: 'reply-1', channelId: 'c1', taskRunId: 'run-1', agentId: 'a1', origin: 'agent', taskRunSeq: 4, role: 'agent', authorName: '规划师', content, status: 'completed', createdAt: '', ...overrides })
let durable: ChannelTaskSnapshot; let emit: (event: StreamEvent) => void; let api: AgentTeamApi; let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  durable = { channel, resumeAllowed: {}, schedulerModelConfigId: null, agents: [], members: [], messages: [], runs: [], turns: [], events: [] }
  unsubscribe = vi.fn()
  api = {
    templates: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), importTeam: vi.fn(), copyAgent: vi.fn() },
    agents: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    channelAgents: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), remove: vi.fn() },
    approvals: { approve: vi.fn(), reject: vi.fn(), expire: vi.fn(), runApproved: vi.fn(), list: vi.fn().mockResolvedValue([]) },
    tools: { list: vi.fn().mockResolvedValue([]) }, workspace: { list: vi.fn().mockResolvedValue({ entries: [] }) }, executables: { list: vi.fn().mockResolvedValue([]), save: vi.fn() },
    projects: { list: vi.fn().mockResolvedValue([project]), pickWorkspace: vi.fn().mockResolvedValue({ id: 'workspace-1', label: '已选择本地目录' }), create: vi.fn().mockResolvedValue(project) },
    channels: { list: vi.fn().mockResolvedValue([channel]), create: vi.fn(), setScheduler: vi.fn(), configure: vi.fn(), remove: vi.fn() },
    models: { list: vi.fn().mockResolvedValue([model]), save: vi.fn().mockResolvedValue(model), remove: vi.fn(), test: vi.fn(), discover: vi.fn(), getDefaultScheduler: vi.fn().mockResolvedValue(null), setDefaultScheduler: vi.fn() },
    messages: { list: vi.fn() }, consent: { has: vi.fn().mockResolvedValue(true), grant: vi.fn() },
    tasks: { list: vi.fn(), snapshot: vi.fn(async () => structuredClone(durable)), send: vi.fn(async () => { durable.runs = [run()]; return { taskRunId: 'run-1' } }), cancel: vi.fn(async () => { durable.runs = [run({ status: 'cancelled', generation: 1 })] }), continue: vi.fn(), assign: vi.fn(), terminate: vi.fn(), interrupt: vi.fn(), acknowledgeProcessRecovery: vi.fn() },
    events: { onStream: vi.fn((listener) => { emit = listener; return unsubscribe }) },
  }
  window.agentTeam = api
})
afterEach(cleanup)
async function ready() { await screen.findByRole('heading', { name: channel.name }); await waitFor(() => expect(screen.getByLabelText('消息内容')).toBeEnabled()) }
async function send() { await ready(); await userEvent.type(screen.getByLabelText('消息内容'), '帮我分析选题'); await userEvent.click(screen.getByRole('button', { name: '发送消息' })); await screen.findByRole('button', { name: '停止生成' }) }
function team() { durable.agents = [agent, { ...agent, id: 'a2', name: '审稿人', avatar: '🔎' }]; durable.members = durable.agents.map((item) => ({ channelId: 'c1', agentId: item.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null, revision: 'r1', createdAt: '', updatedAt: '' })) }

it('selects a workspace immediately and preserves the default initial channel', async () => {
  vi.mocked(api.projects.list).mockResolvedValue([]); render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '新建项目' })); await userEvent.type(screen.getByLabelText('项目名称'), '内容矩阵'); await userEvent.click(screen.getByLabelText('本地目录'))
  expect(api.projects.pickWorkspace).toHaveBeenCalledTimes(1); await userEvent.click(screen.getByRole('button', { name: '确认创建项目' })); await ready()
  expect(api.projects.create).toHaveBeenCalledWith({ name: '内容矩阵', workspaceId: 'workspace-1', firstChannelName: '' })
})
it('renders true Agent identity and keeps a Run running after its first completed Turn', async () => {
  team(); durable.runs = [run({ currentTurnId: 'turn-2', turnCount: 2 })]; durable.turns = [turn({ status: 'completed' }), turn({ id: 'turn-2', ordinal: 2, agentId: 'a2' })]; durable.messages = [reply('规划已完成')]
  render(<App />); await ready()
  expect(screen.getByRole('log')).toHaveTextContent('规划师'); expect(screen.getByRole('log')).toHaveTextContent('🧭')
  expect(screen.getByLabelText('CEO 任务控制')).toHaveTextContent('当前发言：审稿人'); expect(screen.getByLabelText('CEO 任务控制')).toHaveTextContent('已启动 2 轮')
  expect(screen.getByRole('button', { name: '停止生成' })).toBeVisible()
  await act(async () => emit({ taskRunId: 'run-1', type: 'delta', generation: 0, turnId: 'turn-1', agentId: 'a1', content: '旧轮迟到' }))
  expect(screen.queryByText('旧轮迟到')).not.toBeInTheDocument()
})
it('fences generation, Agent and Turn streams and replaces tool-hop previews with the final durable reply', async () => {
  team(); durable.runs = [run({ generation: 2, currentTurnId: 'turn-1', turnCount: 1 })]; durable.turns = [turn({ generation: 2 })]
  render(<App />); await ready()
  await act(async () => {
    emit({ taskRunId: 'run-1', type: 'delta', generation: 1, turnId: 'turn-1', agentId: 'a1', content: '旧代次' })
    emit({ taskRunId: 'run-1', type: 'delta', generation: 2, turnId: 'turn-1', agentId: 'a2', content: '伪发言者' })
    emit({ taskRunId: 'run-1', type: 'delta', generation: 2, turnId: 'turn-1', agentId: 'a1', step: 0, content: '读取工具前' })
    emit({ taskRunId: 'run-1', type: 'delta', generation: 2, turnId: 'turn-1', agentId: 'a1', step: 1, content: '最终回复' })
  })
  expect(screen.getByText('最终回复')).toBeVisible(); expect(screen.queryByText(/旧代次|伪发言者|读取工具前/)).not.toBeInTheDocument()
  durable.messages = [reply('持久化完整最终回复')]; durable.runs = [run({ status: 'completed', generation: 2, turnCount: 1 })]; durable.turns = [turn({ status: 'completed', generation: 2 })]
  await act(async () => emit({ taskRunId: 'run-1', type: 'complete' }))
  expect(await screen.findByText('持久化完整最终回复')).toBeVisible(); expect(screen.queryByText('最终回复')).not.toBeInTheDocument()
})
it('inserts ordered structured mentions and invalidates a token when its text is edited', async () => {
  team(); render(<App />); await ready()
  await userEvent.selectOptions(screen.getByLabelText('@ 指派成员'), 'a1'); await userEvent.type(screen.getByLabelText('消息内容'), '请先规划 '); await userEvent.selectOptions(screen.getByLabelText('@ 指派成员'), 'a2')
  expect(screen.getByLabelText('指派顺序')).toHaveTextContent('1. @规划师2. @审稿人')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(api.tasks.send).toHaveBeenCalledWith(expect.objectContaining({ mentions: [expect.objectContaining({ agentId: 'a1', start: 0, end: 4, text: '@规划师' }), expect.objectContaining({ agentId: 'a2', text: '@审稿人' })] }))
})
it('buffers a first bound delta arriving before the send response without duplicating a persisted reply', async () => {
  team(); vi.mocked(api.tasks.send).mockImplementation(async () => {
    durable.runs = [run({ currentTurnId: 'turn-1', turnCount: 1 })]; durable.turns = [turn()]
    emit({ taskRunId: 'run-1', type: 'delta', generation: 0, turnId: 'turn-1', agentId: 'a1', content: '快速回复' })
    return { taskRunId: 'run-1' }
  })
  render(<App />); await send(); expect(await screen.findByText('快速回复')).toBeVisible()
  durable.messages = [reply('快速回复')]; durable.runs = [run({ status: 'completed', turnCount: 1 })]; durable.turns = [turn({ status: 'completed' })]
  await act(async () => emit({ taskRunId: 'run-1', type: 'complete' })); expect(screen.getAllByText('快速回复')).toHaveLength(1)
})
it('isolates the hidden channel stream while restoring its durable history on reselection', async () => {
  const other = { ...channel, id: 'c2', name: '第二群' }; vi.mocked(api.channels.list).mockResolvedValue([channel, other])
  team(); durable.runs = [run({ currentTurnId: 'turn-1', turnCount: 1 })]; durable.turns = [turn()]
  vi.mocked(api.tasks.snapshot).mockImplementation(async (id) => id === 'c1' ? structuredClone(durable) : { ...structuredClone(durable), channel: other, messages: [], runs: [], turns: [] })
  render(<App />); await ready(); await userEvent.click(screen.getByRole('button', { name: '第二群' }))
  await act(async () => emit({ taskRunId: 'run-1', type: 'delta', generation: 0, turnId: 'turn-1', agentId: 'a1', content: '第一群文本' }))
  expect(screen.queryByText('第一群文本')).not.toBeInTheDocument()
  durable.messages = [reply('第一群完成文本')]; durable.runs = [run({ status: 'completed', turnCount: 1 })]; durable.turns = [turn({ status: 'completed' })]
  await userEvent.click(screen.getByRole('button', { name: channel.name })); expect(await screen.findByText('第一群完成文本')).toBeVisible()
})
it('previews Agent and scheduler categories and authorizes each exact model only after a click', async () => {
  team(); durable.schedulerModelConfigId = 'm2'; vi.mocked(api.models.list).mockResolvedValue([model, { ...model, id: 'm2', modelName: 'scheduler' }])
  const granted = new Set<string>(); vi.mocked(api.consent.has).mockImplementation(async (_p, id) => granted.has(id)); vi.mocked(api.consent.grant).mockImplementation(async (_p, id) => { granted.add(id) })
  render(<App />); await ready(); await userEvent.type(screen.getByLabelText('消息内容'), '私有计划'); await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(await screen.findByRole('dialog', { name: '云端模型授权' })).toHaveTextContent('Agent 规划师'); expect(api.tasks.send).not.toHaveBeenCalled(); expect(api.consent.grant).not.toHaveBeenCalled()
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox')); await userEvent.click(screen.getByRole('button', { name: '同意并发送' }))
  expect(await screen.findByRole('dialog', { name: '云端模型授权' })).toHaveTextContent('自动选人'); expect(screen.getByRole('dialog')).toHaveTextContent('每 10 个完成轮次的摘要'); expect(screen.getByRole('dialog')).toHaveTextContent('scheduler')
  expect(api.tasks.send).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: '暂不发送' }))
  expect(api.consent.grant).toHaveBeenCalledTimes(1); expect(screen.getByLabelText('消息内容')).toHaveValue('私有计划')
})
it('waits for persisted cancellation and discards late output', async () => {
  render(<App />); await send(); await userEvent.click(screen.getByRole('button', { name: '停止生成' })); await screen.findByText('已取消')
  await act(async () => emit({ taskRunId: 'run-1', type: 'delta', generation: 0, content: '迟到输出' }))
  expect(screen.queryByText('迟到输出')).not.toBeInTheDocument(); expect(api.tasks.cancel).toHaveBeenCalledWith('run-1')
})
it('shows persisted pause and scheduling reason after initialization and allows explicit assign', async () => {
  team(); durable.runs = [run({ status: 'paused', pauseReason: '请 CEO 指派下一位', turnCount: 2 })]
  durable.resumeAllowed = { 'run-1': true }
  durable.events = [{ id: 'e1', taskRunId: 'run-1', seq: 9, generation: 0, eventType: 'speaker_decided', agentId: 'a1', messageId: null, toolExecutionId: null, displayReason: '优先核对计划', createdAt: '' }]
  render(<App />); await ready(); expect(screen.getByLabelText('CEO 任务控制')).toHaveTextContent('优先核对计划'); expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('下一位 Agent'), 'a2'); await userEvent.click(screen.getByRole('button', { name: '指派并继续' })); await waitFor(() => expect(api.tasks.assign).toHaveBeenCalledWith('run-1', 'a2'))
})
it('disables resume during a pending approval while keeping the Run running', async () => {
  team(); durable.runs = [run({ currentTurnId: 'turn-1', turnCount: 1 })]; durable.turns = [turn({ status: 'waiting_approval' })]
  render(<App />); await ready(); expect(screen.getByRole('button', { name: '继续当前任务' })).toBeDisabled(); expect(screen.getByLabelText('CEO 任务控制')).toHaveTextContent('下一位 Agent 不会发言')
})
it.each(['approved effect', 'rejected approval', 'expired approval'])('enables explicit continue and assign after Main confirms %s is terminal', async () => {
  team(); durable.runs = [run({ currentTurnId: 'turn-1', turnCount: 1 })]; durable.turns = [turn({ status: 'waiting_approval' })]; durable.resumeAllowed = { 'run-1': true }
  render(<App />); await ready(); expect(screen.getByRole('button', { name: '继续当前任务' })).toBeEnabled(); expect(screen.getByLabelText('CEO 任务控制')).toHaveTextContent('等待 CEO 继续')
  await userEvent.selectOptions(screen.getByLabelText('下一位 Agent'), 'a2'); expect(screen.getByRole('button', { name: '指派并继续' })).toBeEnabled()
})
it('does not grant process recovery until manual stop and verification is checked', async () => {
  render(<ToolCard items={[{ id: 't1', taskRunId: 'run-1', toolName: 'run_process', riskLevel: 'high', status: 'failed', resultSummary: null, createdAt: '', processRecoveryRequired: true }]} onChanged={() => {}} />)
  expect(screen.getByRole('button', { name: '登记人工核验' })).toBeDisabled(); expect(api.tasks.acknowledgeProcessRecovery).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('checkbox')); await userEvent.click(screen.getByRole('button', { name: '登记人工核验' }))
  expect(api.tasks.acknowledgeProcessRecovery).toHaveBeenCalledWith('run-1', 't1', 'manually_stopped_and_verified')
})
it('executes approval only after an explicit click', async () => {
  render(<ApprovalCard items={[{ id: 'ap1', toolExecutionId: 't1', requestHash: 'a'.repeat(64), status: 'approved', expiresAt: '' }]} onChanged={() => {}} />)
  expect(api.approvals.runApproved).not.toHaveBeenCalled(); await userEvent.click(screen.getByRole('button', { name: '执行已批准操作' })); expect(api.approvals.runApproved).toHaveBeenCalledWith('ap1')
})
it('retains draft and hides internal diagnostics on send rejection, and releases subscriptions', async () => {
  vi.mocked(api.tasks.send).mockRejectedValue(new Error('PRIVATE_KEY')); const view = render(<App />); await ready(); await userEvent.type(screen.getByLabelText('消息内容'), '保留草稿'); await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('操作未完成'); expect(screen.getByLabelText('消息内容')).toHaveValue('保留草稿'); expect(screen.queryByText(/PRIVATE_KEY/)).not.toBeInTheDocument(); view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1)
})
it('keeps confirmed deletion and refreshes the fallback channel', async () => {
  const other = { ...channel, id: 'c2', name: '保留群聊' }; vi.mocked(api.channels.list).mockResolvedValue([channel, other]); vi.mocked(api.channels.remove).mockImplementation(async () => { vi.mocked(api.channels.list).mockResolvedValue([other]); durable.channel = other })
  render(<App />); await ready(); await userEvent.click(screen.getByRole('button', { name: '删除当前群聊' })); const dialog = await screen.findByRole('dialog', { name: '删除群聊' }); expect(api.channels.remove).not.toHaveBeenCalled()
  await userEvent.click(within(dialog).getByRole('button', { name: '确认删除群聊' })); expect(await screen.findByRole('heading', { name: '保留群聊' })).toBeVisible(); expect(api.channels.remove).toHaveBeenCalledWith({ channelId: 'c1', confirmation: 'delete_channel_records' })
})
