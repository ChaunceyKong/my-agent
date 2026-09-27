// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { AgentTeamApi, Channel, Message, Project, StreamEvent, TaskRun } from '../shared/types'

const project: Project = { id: 'p1', name: '内容矩阵', workspacePath: 'C:/work/content', icon: null, createdAt: '', updatedAt: '' }
const channel: Channel = { id: 'c1', projectId: 'p1', name: '主线任务协同群', icon: null, createdAt: '', updatedAt: '' }
const model = { id: 'm1', providerPreset: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', modelName: 'deepseek-chat', hasApiKey: true }
let emitStream: (event: StreamEvent) => void
let api: AgentTeamApi
let unsubscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  unsubscribe = vi.fn()
  api = {
    agents: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    channelAgents: { list: vi.fn().mockResolvedValue([]), save: vi.fn(), remove: vi.fn() },
    approvals: { approve: vi.fn(), reject: vi.fn(), expire: vi.fn(), runApproved: vi.fn() },
    executables: { list: vi.fn().mockResolvedValue([]), save: vi.fn() },
    projects: { list: vi.fn().mockResolvedValue([project]), pickWorkspace: vi.fn().mockResolvedValue('C:/work/content'), create: vi.fn().mockResolvedValue(project) },
    channels: { list: vi.fn().mockResolvedValue([channel]), create: vi.fn().mockResolvedValue({ ...channel, id: 'c2', name: '选题群' }) },
    models: { list: vi.fn().mockResolvedValue([model]), save: vi.fn().mockResolvedValue({ ...model, id: 'm2' }) },
    messages: { list: vi.fn().mockResolvedValue([]) },
    consent: { has: vi.fn().mockResolvedValue(true), grant: vi.fn().mockResolvedValue(undefined) },
    tasks: { list: vi.fn().mockResolvedValue([]), send: vi.fn().mockResolvedValue({ taskRunId: 'run-1' }), cancel: vi.fn().mockResolvedValue(undefined) },
    events: { onStream: vi.fn((listener) => { emitStream = listener; return unsubscribe }) },
  }
  window.agentTeam = api
})
afterEach(cleanup)

function persistedReply(taskRunId: string, content: string): Message {
  return { id: `persisted-${taskRunId}`, channelId: 'c1', taskRunId, role: 'agent', authorName: 'AI 助手', content, status: 'completed', createdAt: '2026-09-21T00:00:00Z' }
}

function persistedRun(status: TaskRun['status']): TaskRun {
  return { id: 'history-run', channelId: 'c1', modelConfigId: 'm1', status, generation: 0, createdAt: '', startedAt: null, finishedAt: null, errorMessage: null }
}

async function send() {
  await screen.findByRole('heading', { name: channel.name })
  await userEvent.type(screen.getByLabelText('消息内容'), '帮我分析选题')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await screen.findByRole('button', { name: '停止生成' })
}

it('selects a workspace immediately and uses the default initial channel when left empty', async () => {
  vi.mocked(api.projects.list).mockResolvedValue([])
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '新建项目' }))
  await userEvent.type(screen.getByLabelText('项目名称'), '内容矩阵')
  await userEvent.click(screen.getByLabelText('本地目录'))
  expect(api.projects.pickWorkspace).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: '确认创建项目' }))
  expect(await screen.findByRole('heading', { name: channel.name })).toBeVisible()
  expect(api.projects.create).toHaveBeenCalledWith({ name: '内容矩阵', workspacePath: 'C:/work/content', firstChannelName: '' })
})

it('appends only matching live deltas and rejects terminal or unknown events', async () => {
  render(<App />)
  await send()
  act(() => {
    emitStream({ taskRunId: 'other', type: 'delta', content: '错误会话内容' })
    emitStream({ taskRunId: 'run-1', type: 'delta', content: '正在分析' })
  })
  expect(screen.getByText('正在分析')).toBeVisible()
  vi.mocked(api.messages.list).mockResolvedValue([persistedReply('run-1', '正在分析')])
  await act(async () => {
    emitStream({ taskRunId: 'run-1', type: 'complete' })
    emitStream({ taskRunId: 'run-1', type: 'delta', content: '迟到内容' })
  })
  expect(screen.queryByText(/错误会话内容|迟到内容/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument()
})

it('buffers early events until the returned run id is known', async () => {
  vi.mocked(api.tasks.send).mockImplementation(async () => {
    vi.mocked(api.messages.list).mockResolvedValue([persistedReply('run-1', '快速响应')])
    emitStream({ taskRunId: 'unknown', type: 'delta', content: '丢弃内容' })
    emitStream({ taskRunId: 'run-1', type: 'delta', content: '快速响应' })
    emitStream({ taskRunId: 'run-1', type: 'complete' })
    return { taskRunId: 'run-1' }
  })
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  await userEvent.type(screen.getByLabelText('消息内容'), '测试')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(await screen.findByText('快速响应')).toBeVisible()
  expect(screen.queryByText('丢弃内容')).not.toBeInTheDocument()
})

it('requires explicit consent for the project and model before sending', async () => {
  vi.mocked(api.consent.has).mockResolvedValue(false)
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  await userEvent.type(screen.getByLabelText('消息内容'), '私有内容')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(await screen.findByRole('dialog', { name: '云端模型授权' })).toBeVisible()
  expect(api.tasks.send).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '同意并发送' }))
  await waitFor(() => expect(api.tasks.send).toHaveBeenCalled())
  expect(api.consent.grant).toHaveBeenCalledWith('p1', 'm1')
})

it('cancels the live run and discards late output', async () => {
  render(<App />)
  await send()
  await userEvent.click(screen.getByRole('button', { name: '停止生成' }))
  await waitFor(() => expect(api.tasks.cancel).toHaveBeenCalledWith('run-1'))
  act(() => emitStream({ taskRunId: 'run-1', type: 'delta', content: '取消后内容' }))
  expect(screen.queryByText('取消后内容')).not.toBeInTheDocument()
  expect(await screen.findByText('已取消')).toBeVisible()
})

it('isolates channel histories and never inserts another channel stream', async () => {
  vi.mocked(api.channels.list).mockResolvedValue([channel, { ...channel, id: 'c2', name: '第二群' }])
  render(<App />)
  await send()
  await userEvent.click(screen.getByRole('button', { name: '第二群' }))
  act(() => emitStream({ taskRunId: 'run-1', type: 'delta', content: '第一群回复' }))
  expect(screen.queryByText('第一群回复')).not.toBeInTheDocument()
  expect(screen.queryByText('帮我分析选题')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: channel.name }))
  expect(await screen.findByText('第一群回复')).toBeVisible()
})

it('shows safe failures, retains draft on send rejection, and unsubscribes', async () => {
  vi.mocked(api.tasks.send).mockRejectedValue(new Error('internal secret'))
  const view = render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  await userEvent.type(screen.getByLabelText('消息内容'), '保留草稿')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('发送失败')
  expect(screen.getByLabelText('消息内容')).toHaveValue('保留草稿')
  expect(screen.queryByText(/internal secret/)).not.toBeInTheDocument()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it('saves credentials through settings and renders explicit unavailable cockpit states', async () => {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '模型设置' }))
  await userEvent.type(screen.getByLabelText('API Key'), 'secret-key')
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(api.models.save).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'secret-key', providerPreset: 'deepseek' })))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByText(/当前版本尚未启用团队成员/)).toBeVisible()
  await userEvent.click(screen.getByRole('tab', { name: '工作区文件' }))
  expect(screen.getByText(/当前版本尚未提供文件浏览/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '收起右侧面板' }))
  expect(screen.queryByRole('complementary', { name: '团队与工作区' })).not.toBeInTheDocument()
})

it('shows persisted paused runs and rejects their late events', async () => {
  vi.mocked(api.tasks.list).mockResolvedValue([{ id: 'paused-run', channelId: 'c1', modelConfigId: 'm1', status: 'paused', generation: 0, createdAt: '', startedAt: null, finishedAt: null, errorMessage: null }])
  render(<App />)
  expect(await screen.findByText('任务已暂停，应用重启后不会自动续跑')).toBeVisible()
  act(() => emitStream({ taskRunId: 'paused-run', type: 'delta', content: '不应出现' }))
  expect(screen.queryByText('不应出现')).not.toBeInTheDocument()
  expect(api.tasks.send).not.toHaveBeenCalled()
})

it('renders stream errors and rejects later events for the failed run', async () => {
  render(<App />)
  await send()
  act(() => {
    emitStream({ taskRunId: 'run-1', type: 'error', content: '模型服务请求失败，请检查配置后重试' })
    emitStream({ taskRunId: 'run-1', type: 'delta', content: '失败后内容' })
  })
  expect(screen.getByRole('alert')).toHaveTextContent('模型服务请求失败')
  expect(screen.queryByText('失败后内容')).not.toBeInTheDocument()
})

it('retains the draft when cloud consent is declined', async () => {
  vi.mocked(api.consent.has).mockResolvedValue(false)
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  await userEvent.type(screen.getByLabelText('消息内容'), '暂不上传')
  await userEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await userEvent.click(await screen.findByRole('button', { name: '暂不发送' }))
  expect(screen.getByLabelText('消息内容')).toHaveValue('暂不上传')
  expect(api.consent.grant).not.toHaveBeenCalled()
  expect(api.tasks.send).not.toHaveBeenCalled()
})

it('creates and selects a channel within the current project', async () => {
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  await userEvent.click(screen.getByRole('button', { name: '新建会话群聊' }))
  await userEvent.type(screen.getByLabelText('群聊名称'), '选题群')
  await userEvent.click(screen.getByRole('button', { name: '确认建群' }))
  expect(await screen.findByRole('heading', { name: '选题群' })).toBeVisible()
  expect(api.channels.create).toHaveBeenCalledWith({ projectId: 'p1', name: '选题群' })
})

it('does not replace the selected project with a stale channel-list response', async () => {
  vi.mocked(api.projects.list).mockResolvedValue([project, { ...project, id: 'p2', name: '第二项目' }])
  let resolveFirst!: (value: Channel[]) => void
  vi.mocked(api.channels.list).mockImplementation((id) => id === 'p1' ? new Promise((resolve) => { resolveFirst = resolve }) : Promise.resolve([{ ...channel, id: 'c2', projectId: 'p2', name: '第二项目群' }]))
  render(<App />)
  await userEvent.selectOptions(await screen.findByLabelText('选择项目'), 'p2')
  expect(await screen.findByRole('heading', { name: '第二项目群' })).toBeVisible()
  await act(async () => resolveFirst([channel]))
  expect(screen.getByRole('heading', { name: '第二项目群' })).toBeVisible()
  expect(screen.queryByRole('button', { name: channel.name })).not.toBeInTheDocument()
})

it('reconciles stream events that arrive while loading a persisted running task', async () => {
  let resolveMessages!: (value: []) => void
  vi.mocked(api.messages.list).mockImplementationOnce(() => new Promise((resolve) => { resolveMessages = resolve })).mockResolvedValue([persistedReply('resumed-view-run', '加载期间的回复')])
  vi.mocked(api.tasks.list).mockResolvedValue([{ id: 'resumed-view-run', channelId: 'c1', modelConfigId: 'm1', status: 'running', generation: 0, createdAt: '', startedAt: null, finishedAt: null, errorMessage: null }])
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  act(() => {
    emitStream({ taskRunId: 'resumed-view-run', type: 'delta', content: '加载期间的回复' })
    emitStream({ taskRunId: 'resumed-view-run', type: 'complete' })
  })
  await act(async () => resolveMessages([]))
  expect(screen.getByText('加载期间的回复')).toBeVisible()
  expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument()
})

it.each(['completed', 'running'] as const)('reads the durable reply when completion races a %s history snapshot', async (status) => {
  let resolveRuns!: (runs: TaskRun[]) => void
  vi.mocked(api.messages.list).mockResolvedValueOnce([]).mockResolvedValue([persistedReply('history-run', '加载竞态中的完整回复')])
  vi.mocked(api.tasks.list).mockImplementation(() => new Promise((resolve) => { resolveRuns = resolve }))
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  act(() => {
    emitStream({ taskRunId: 'history-run', type: 'delta', content: '末尾片段' })
    emitStream({ taskRunId: 'history-run', type: 'complete' })
  })
  await act(async () => resolveRuns([persistedRun(status)]))
  expect(await screen.findByText('加载竞态中的完整回复')).toBeVisible()
  expect(screen.queryByText('末尾片段')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument()
})

it('replaces the streamed tail with the durable full reply after reloading mid-generation', async () => {
  vi.mocked(api.tasks.list).mockResolvedValue([persistedRun('running')])
  render(<App />)
  await screen.findByRole('button', { name: '停止生成' })
  act(() => emitStream({ taskRunId: 'history-run', type: 'delta', content: '只收到末尾' }))
  expect(screen.getByText('只收到末尾')).toBeVisible()
  vi.mocked(api.messages.list).mockResolvedValue([persistedReply('history-run', '刷新前的开头，加上只收到末尾')])
  act(() => {
    emitStream({ taskRunId: 'history-run', type: 'complete' })
    emitStream({ taskRunId: 'history-run', type: 'delta', content: '迟到追加' })
  })
  expect(await screen.findByText('刷新前的开头，加上只收到末尾')).toBeVisible()
  expect(screen.queryByText('只收到末尾')).not.toBeInTheDocument()
  expect(screen.queryByText(/迟到追加/)).not.toBeInTheDocument()
})

it('never appends buffered deltas onto an already persisted completed reply', async () => {
  let resolveRuns!: (runs: TaskRun[]) => void
  vi.mocked(api.messages.list).mockResolvedValue([persistedReply('history-run', '已持久化的完整回复')])
  vi.mocked(api.tasks.list).mockImplementation(() => new Promise((resolve) => { resolveRuns = resolve }))
  render(<App />)
  await screen.findByRole('heading', { name: channel.name })
  act(() => emitStream({ taskRunId: 'history-run', type: 'delta', content: '重复尾部' }))
  await act(async () => resolveRuns([persistedRun('running')]))
  expect(screen.getByText('已持久化的完整回复')).toBeVisible()
  expect(screen.queryByText(/重复尾部/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument()
})
