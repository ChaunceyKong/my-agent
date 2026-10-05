// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentManager } from './AgentManager'
import type { Agent, AgentTeamApi, Channel, ChannelAgent } from '../../../shared/types'

const channel: Channel = { id: 'c', projectId: 'p', name: 'team', icon: null, speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null, createdAt: '', updatedAt: '' }
const models = [{ id: 'm', modelName: 'default-model', providerPreset: 'openai' as const, baseUrl: 'https://example.test', hasApiKey: true }, { id: 'override', modelName: 'override-model', providerPreset: 'openai' as const, baseUrl: 'https://example.test', hasApiKey: true }]
const first: Agent = { id: 'a', name: 'Writer', avatar: '✍️', title: 'writer', systemPrompt: 'keep prompt', modelConfigId: 'm', defaultToolPermissions: { read_file: true, write_file: true }, isBuiltin: false, createdAt: '', updatedAt: '' }
const second: Agent = { ...first, id: 'b', name: 'Reviewer', avatar: '🔎' }
let members: ChannelAgent[]
let api: AgentTeamApi
beforeEach(() => {
  members = [first, second].map((agent) => ({ channelId: 'c', agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null, revision: 'rev', createdAt: '', updatedAt: '' }))
  api = {
    templates: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), importTeam: vi.fn(), copyAgent: vi.fn() },
    agents: { list: vi.fn().mockResolvedValue([first, second]), get: vi.fn().mockResolvedValue(first), update: vi.fn().mockResolvedValue(first), create: vi.fn(), remove: vi.fn() },
    channelAgents: { list: vi.fn(async () => members), save: vi.fn(async (input) => { const saved = { ...members.find((item) => item.agentId === input.agentId)!, ...input }; members = members.map((item) => item.agentId === input.agentId ? saved : item); return saved }), remove: vi.fn(async (_, id) => { members = members.filter((item) => item.agentId !== id) }) },
    channels: { configure: vi.fn().mockResolvedValue({ ...channel, speakerMode: 'manual', maxTurns: 12, schedulerModelConfigId: 'override' }) },
  } as unknown as AgentTeamApi
  window.agentTeam = api
})
afterEach(cleanup)

const role = { id: 'writer', name: '模板作者', avatar: '✍️', title: '作者', systemPrompt: '模板提示原文', responsibilities: ['查证来源'], outputFormat: '正文与出处' }
const template = { id: 'media', name: '内容团队', avatar: '📝', description: '模板说明', roles: [role] }
function catalog() {
  vi.mocked(api.templates.list).mockResolvedValue([{ ...template, roleCount: 1, roleNames: [role.name] }])
  vi.mocked(api.templates.get).mockResolvedValue(template)
  vi.mocked(api.templates.copyAgent).mockResolvedValue({ agents: [], members: [] })
}

async function openRecommendations() {
  await userEvent.click(await screen.findByRole('button', { name: '＋ 添加 Agent' }))
  await userEvent.click(screen.getByRole('button', { name: '推荐实例' }))
}

it('previews the entire prompt and copies only editor identity/model with tools disabled', async () => {
  catalog(); render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await openRecommendations()
  await userEvent.click(await screen.findByRole('button', { name: '预览模板：内容团队' }))
  expect(await screen.findByText('模板提示原文')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '复制并编辑：模板作者' }))
  expect(screen.getByLabelText('write_file')).toBeDisabled()
  await userEvent.clear(screen.getByLabelText('Agent 名称')); await userEvent.type(screen.getByLabelText('Agent 名称'), '副本作者')
  await userEvent.clear(screen.getByLabelText('Agent 系统提示')); await userEvent.type(screen.getByLabelText('Agent 系统提示'), '自定义提示')
  await userEvent.selectOptions(screen.getByLabelText('Agent 模型'), 'override')
  await userEvent.click(screen.getByRole('button', { name: '创建模板副本' }))
  await waitFor(() => expect(api.templates.copyAgent).toHaveBeenCalledWith({ templateId: 'media', roleId: 'writer', channelId: 'c', editor: { name: '副本作者', avatar: '✍️', title: '作者', systemPrompt: '自定义提示', modelConfigId: 'override' } }))
  expect(template.roles[0].systemPrompt).toBe('模板提示原文')
})

it('ignores a completed import callback after unmounting the old Channel', async () => {
  catalog(); let resolve!: (value: { agents: Agent[]; members: ChannelAgent[] }) => void
  vi.mocked(api.templates.importTeam).mockReturnValue(new Promise((done) => { resolve = done }))
  const changed = vi.fn(); const view = render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} onMembersChanged={changed} />)
  await openRecommendations()
  await userEvent.click(await screen.findByRole('button', { name: '导入团队：内容团队' }))
  const reads = vi.mocked(api.agents.list).mock.calls.length
  view.unmount(); await act(async () => resolve({ agents: [], members: [] }))
  expect(changed).not.toHaveBeenCalled()
  // No state from the old import is displayed in a later Channel instance.
  expect(vi.mocked(api.agents.list).mock.calls.length).toBe(reads)
})

it('renders multiple enabled members and changes one membership without overwriting the other', async () => {
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await screen.findByRole('button', { name: '停用群聊 Agent：Writer' })
  expect(screen.getByRole('button', { name: '停用群聊 Agent：Reviewer' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '停用群聊 Agent：Writer' }))
  expect(await screen.findByRole('button', { name: '启用群聊 Agent：Writer' })).toBeVisible()
  expect(screen.getByRole('button', { name: '停用群聊 Agent：Reviewer' })).toBeVisible()
  expect(api.channelAgents.save).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: '移出群聊：Writer' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: '移出群聊：Writer' })).not.toBeInTheDocument())
  await userEvent.click(screen.getByRole('button', { name: '＋ 添加 Agent' }))
  await userEvent.click(screen.getByRole('button', { name: '已有 Agent' }))
  expect(await screen.findByRole('button', { name: '加入群聊：Writer' })).toBeVisible()
  expect(api.channelAgents.remove).toHaveBeenCalledWith('c', 'a')
})

it('saves member model override and only exposes permissions authorized by the Agent', async () => {
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: '群聊成员设置：Writer' }))
  await userEvent.selectOptions(screen.getByLabelText('群聊成员模型'), 'override')
  await userEvent.click(screen.getByLabelText('使用 Agent 默认工具权限'))
  expect(screen.getByLabelText('群聊权限 run_process')).toBeDisabled()
  expect(screen.getByLabelText('群聊权限 search_files')).toBeDisabled()
  await userEvent.click(screen.getByLabelText('群聊权限 write_file'))
  await userEvent.click(screen.getByRole('button', { name: '保存成员设置' }))
  await waitFor(() => expect(api.channelAgents.save).toHaveBeenCalledWith({ channelId: 'c', agentId: 'a', isEnabled: true, modelConfigOverrideId: 'override', toolPermissionsOverride: { read_file: true, write_file: false } }))
})

it('edits avatar as text while retaining Prompt, model and permission settings', async () => {
  vi.mocked(api.agents.get).mockResolvedValue({ ...first, avatar: '<img>' })
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: '编辑 Agent：Writer' }))
  await waitFor(() => expect(screen.getByLabelText('Agent 头像')).toHaveValue('<img>'))
  expect(document.querySelector('img')).toBeNull()
  await userEvent.clear(screen.getByLabelText('Agent 头像'))
  await userEvent.type(screen.getByLabelText('Agent 头像'), '🤖')
  await userEvent.click(screen.getByRole('button', { name: '保存 Agent' }))
  await waitFor(() => expect(api.agents.update).toHaveBeenCalledWith('a', expect.objectContaining({ avatar: '🤖', systemPrompt: 'keep prompt', modelConfigId: 'm', defaultToolPermissions: { read_file: true, write_file: true } })))
})

it('saves Channel manual mode, override scheduler and turn budget then refreshes parent state', async () => {
  const changed = vi.fn()
  render(<AgentManager channel={channel} models={models} onChannelChanged={changed} />)
  await userEvent.click(screen.getByText('群聊调度设置'))
  await userEvent.selectOptions(screen.getByLabelText('发言模式'), 'manual')
  await userEvent.selectOptions(screen.getByLabelText('群聊调度模型'), 'override')
  await userEvent.clear(screen.getByLabelText('群聊轮数上限'))
  await userEvent.type(screen.getByLabelText('群聊轮数上限'), '12')
  await userEvent.click(screen.getByRole('button', { name: '保存群聊配置' }))
  expect(api.channels.configure).toHaveBeenCalledWith({ channelId: 'c', speakerMode: 'manual', maxTurns: 12, schedulerModelConfigId: 'override' })
  await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ speakerMode: 'manual', maxTurns: 12 })))
})

it('shows only current Channel members and keeps creation and recommendations inside the add dialog', async () => {
  members = members.filter((member) => member.agentId === first.id)
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  expect(await screen.findByText('Writer')).toBeVisible()
  expect(screen.queryByText('Reviewer')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Agent 名称')).not.toBeInTheDocument()
  expect(api.templates.list).not.toHaveBeenCalled()
  expect(screen.getByLabelText('发言模式')).not.toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '＋ 添加 Agent' }))
  const dialog = screen.getByRole('dialog', { name: '添加 Agent' })
  expect(within(dialog).getByLabelText('Agent 名称')).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: '已有 Agent' }))
  expect(within(dialog).getByText('Reviewer')).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: '加入群聊：Reviewer' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(api.channelAgents.save).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'c', agentId: 'b', isEnabled: true }))
})

it('creates and joins a custom Agent, retaining its ID if joining needs a retry', async () => {
  vi.mocked(api.agents.create).mockResolvedValue({ ...first, id: 'new', name: '新作者' })
  vi.mocked(api.agents.update).mockResolvedValue({ ...first, id: 'new', name: '新作者' })
  vi.mocked(api.channelAgents.save).mockRejectedValueOnce(new Error('加入失败'))
  const changed = vi.fn()
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} onMembersChanged={changed} />)
  await userEvent.click(await screen.findByRole('button', { name: '＋ 添加 Agent' }))
  await userEvent.type(screen.getByLabelText('Agent 名称'), '新作者')
  await userEvent.type(screen.getByLabelText('Agent 角色'), '作者')
  await userEvent.type(screen.getByLabelText('Agent 系统提示'), '写作职责')
  await userEvent.click(screen.getByRole('button', { name: '创建并加入群聊' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('加入失败')
  expect(screen.getByRole('dialog', { name: '添加 Agent' })).toBeVisible()
  expect(changed).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '创建并加入群聊' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(api.agents.create).toHaveBeenCalledTimes(1)
  expect(api.agents.update).toHaveBeenCalledWith('new', expect.objectContaining({ name: '新作者' }))
  expect(api.channelAgents.save).toHaveBeenLastCalledWith({ channelId: 'c', agentId: 'new', isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  expect(changed).toHaveBeenCalledTimes(1)
})

it('directly imports a recommended role without opening a second dialog or requiring edits', async () => {
  catalog(); render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await openRecommendations()
  await userEvent.click(await screen.findByRole('button', { name: '导入 Agent：模板作者' }))
  expect(api.templates.copyAgent).toHaveBeenCalledWith({ templateId: 'media', roleId: 'writer', channelId: 'c', editor: { name: role.name, avatar: role.avatar, title: role.title, systemPrompt: role.systemPrompt, modelConfigId: 'm' } })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

it('keeps failed imports reviewable in the modal and closes it with Escape without writing', async () => {
  catalog(); vi.mocked(api.templates.copyAgent).mockRejectedValue(new Error('任务正在运行'))
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await openRecommendations()
  await userEvent.click(await screen.findByRole('button', { name: '导入 Agent：模板作者' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('任务正在运行')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(api.agents.create).not.toHaveBeenCalled()
})

it('allows browsing recommendations without a model while preventing creation and import', async () => {
  catalog(); render(<AgentManager channel={channel} models={[]} onChannelChanged={() => {}} />)
  await userEvent.click(await screen.findByRole('button', { name: '＋ 添加 Agent' }))
  expect(screen.getByText('尚未配置模型')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '推荐实例' }))
  expect(await screen.findByRole('button', { name: '导入 Agent：模板作者' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '导入团队：内容团队' })).toBeDisabled()
})

it('resets the open editor on Channel changes and ignores a late old import', async () => {
  catalog(); let resolve!: (value: { agents: Agent[]; members: ChannelAgent[] }) => void
  vi.mocked(api.templates.copyAgent).mockReturnValue(new Promise((done) => { resolve = done }))
  const changed = vi.fn(); const view = render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} onMembersChanged={changed} />)
  await openRecommendations()
  await userEvent.click(await screen.findByRole('button', { name: '导入 Agent：模板作者' }))
  members = []
  view.rerender(<AgentManager channel={{ ...channel, id: 'next', name: '另一群聊' }} models={models} onChannelChanged={() => {}} onMembersChanged={changed} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => resolve({ agents: [], members: [] }))
  expect(changed).not.toHaveBeenCalled()
  expect(await screen.findByText('当前群聊还没有 Agent')).toBeVisible()
  expect(screen.getByRole('button', { name: '＋ 添加 Agent' })).toBeEnabled()
})
