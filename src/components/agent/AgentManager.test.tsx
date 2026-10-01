// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    agents: { list: vi.fn().mockResolvedValue([first, second]), get: vi.fn().mockResolvedValue(first), update: vi.fn().mockResolvedValue(first), create: vi.fn(), remove: vi.fn() },
    channelAgents: { list: vi.fn(async () => members), save: vi.fn(async (input) => { const saved = { ...members.find((item) => item.agentId === input.agentId)!, ...input }; members = members.map((item) => item.agentId === input.agentId ? saved : item); return saved }), remove: vi.fn(async (_, id) => { members = members.filter((item) => item.agentId !== id) }) },
    channels: { configure: vi.fn().mockResolvedValue({ ...channel, speakerMode: 'manual', maxTurns: 12, schedulerModelConfigId: 'override' }) },
  } as unknown as AgentTeamApi
  window.agentTeam = api
})
afterEach(cleanup)

it('renders multiple enabled members and changes one membership without overwriting the other', async () => {
  render(<AgentManager channel={channel} models={models} onChannelChanged={() => {}} />)
  await screen.findByRole('button', { name: '停用群聊 Agent：Writer' })
  expect(screen.getByRole('button', { name: '停用群聊 Agent：Reviewer' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '停用群聊 Agent：Writer' }))
  expect(await screen.findByRole('button', { name: '启用群聊 Agent：Writer' })).toBeVisible()
  expect(screen.getByRole('button', { name: '停用群聊 Agent：Reviewer' })).toBeVisible()
  expect(api.channelAgents.save).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: '移出群聊：Writer' }))
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
  await userEvent.selectOptions(screen.getByLabelText('发言模式'), 'manual')
  await userEvent.selectOptions(screen.getByLabelText('群聊调度模型'), 'override')
  await userEvent.clear(screen.getByLabelText('群聊轮数上限'))
  await userEvent.type(screen.getByLabelText('群聊轮数上限'), '12')
  await userEvent.click(screen.getByRole('button', { name: '保存群聊配置' }))
  expect(api.channels.configure).toHaveBeenCalledWith({ channelId: 'c', speakerMode: 'manual', maxTurns: 12, schedulerModelConfigId: 'override' })
  await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ speakerMode: 'manual', maxTurns: 12 })))
})
