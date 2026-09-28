import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentService } from '../../electron/core/agent-service'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { migrate } from '../../electron/database/schema'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'

let database: DatabaseClient
let repositories: Repositories
let service: ReturnType<typeof createAgentService>
let modelConfigId: string
let channelId: string

beforeEach(async () => {
  database = createDatabase({ filePath: ':memory:' })
  repositories = createRepositories(database)
  service = createAgentService(repositories)
  modelConfigId = (await repositories.saveModelConfig({
    providerPreset: 'openai', modelName: 'test', baseUrl: 'https://example.test', encryptedApiKey: 'PRIVATE_KEY',
  })).id
  channelId = (await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: 'C:/test' })).channel.id
})

afterEach(() => database.close())

const input = () => ({ name: 'Writer', title: 'Editor', avatar: null, systemPrompt: 'PRIVATE_PROMPT', modelConfigId, defaultToolPermissions: { read_file: true } })

it('creates, edits and lists prompt-free summaries; only the requested editor record contains its prompt', async () => {
  const created = await service.create(input())
  expect(created).not.toHaveProperty('systemPrompt')
  expect(created.isBuiltin).toBe(false)
  const updated = await service.update(created.id, { ...input(), name: 'Reviewer', systemPrompt: 'UPDATED_PROMPT' })
  expect(await service.list()).toEqual([updated])
  expect(await service.get(created.id)).toMatchObject({ name: 'Reviewer', systemPrompt: 'UPDATED_PROMPT' })
  expect(JSON.stringify(await service.list())).not.toMatch(/PROMPT|PRIVATE_KEY|encryptedApiKey/)
  await service.remove(created.id)
  expect(await service.list()).toEqual([])
  await expect(service.get(created.id)).rejects.toThrow('Agent 不存在')
})

it('rejects missing model configs on create, update and membership overrides without changing records', async () => {
  await expect(service.create({ ...input(), modelConfigId: 'missing' })).rejects.toThrow('模型配置不存在')
  const agent = await service.create(input())
  await expect(service.update(agent.id, { ...input(), modelConfigId: 'missing' })).rejects.toThrow('模型配置不存在')
  await expect(service.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: 'missing', toolPermissionsOverride: null })).rejects.toThrow('模型配置不存在')
  expect((await service.get(agent.id)).modelConfigId).toBe(modelConfigId)
  expect(await service.listChannelAgents(channelId)).toEqual([])
})

it('enables one member at a time and supports disabled membership updates, removal and reference-safe deletion', async () => {
  const first = await service.create(input())
  const second = await service.create({ ...input(), name: 'Second' })
  const member = (agentId: string, isEnabled: boolean) => ({ channelId, agentId, isEnabled, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await service.saveChannelAgent(member(first.id, true))
  await service.saveChannelAgent(member(second.id, true))
  expect(await service.listChannelAgents(channelId)).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentId: first.id, isEnabled: false }),
    expect.objectContaining({ agentId: second.id, isEnabled: true }),
  ]))
  await service.saveChannelAgent({ ...member(first.id, false), toolPermissionsOverride: { read_file: false } })
  expect((await service.listChannelAgents(channelId)).find((item) => item.agentId === second.id)?.isEnabled).toBe(true)
  await expect(service.remove(first.id)).rejects.toThrow('Agent 仍被群聊引用')
  await service.removeChannelAgent(channelId, first.id)
  await service.remove(first.id)
  await service.saveChannelAgent(member(second.id, false))
  expect((await service.listChannelAgents(channelId)).filter((item) => item.isEnabled)).toEqual([])
})

it('rolls back disabling the previous member when saving the new member fails inside the transaction', async () => {
  const first = await service.create(input())
  await service.saveChannelAgent({ channelId, agentId: first.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await expect(repositories.saveChannelAgent({ channelId, agentId: 'missing', isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })).rejects.toThrow()
  expect(await service.listChannelAgents(channelId)).toEqual([expect.objectContaining({ agentId: first.id, isEnabled: true })])
})

it('keeps memberships isolated by Channel and rejects unknown Channels or Agents', async () => {
  const agent = await service.create(input())
  const other = (await repositories.createProjectWithInitialChannel({ name: 'other', workspacePath: 'C:/other' })).channel
  await service.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  expect(await service.listChannelAgents(other.id)).toEqual([])
  await service.saveChannelAgent({ channelId: other.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: modelConfigId, toolPermissionsOverride: { read_file: true } })
  expect(await service.listChannelAgents(channelId)).toEqual([expect.objectContaining({ agentId: agent.id, isEnabled: true })])
  expect(await service.listChannelAgents(other.id)).toEqual([expect.objectContaining({ agentId: agent.id, isEnabled: true, modelConfigOverrideId: modelConfigId, toolPermissionsOverride: { read_file: true } })])
  await expect(service.saveChannelAgent({ channelId: 'missing', agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })).rejects.toThrow('群聊不存在')
  await expect(service.saveChannelAgent({ channelId, agentId: 'missing', isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })).rejects.toThrow('Agent 不存在')
})

it('retains Agent editor fields and membership across database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-team-agent-'))
  const filePath = join(directory, 'agent-team.sqlite')
  let persistent = createDatabase({ filePath })
  try {
    const repo = createRepositories(persistent)
    const model = await repo.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'KEY' })
    const { channel } = await repo.createProjectWithInitialChannel({ name: 'persistent', workspacePath: directory })
    const api = createAgentService(repo)
    const agent = await api.create({ ...input(), modelConfigId: model.id })
    const membership = await api.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: {} })
    persistent.close()
    persistent = createDatabase({ filePath })
    const reopened = createAgentService(createRepositories(persistent))
    expect(await reopened.list()).toEqual([agent])
    expect((await reopened.get(agent.id)).systemPrompt).toBe('PRIVATE_PROMPT')
    expect(await reopened.listChannelAgents(channel.id)).toEqual([membership])
  } finally {
    persistent.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('validates untrusted editor and permission fields before persistence', async () => {
  await expect(service.create({ ...input(), name: ' ' })).rejects.toThrow()
  await expect(service.create({ ...input(), defaultToolPermissions: { read_file: 'yes' } } as any)).rejects.toThrow()
  await expect(service.create({ ...input(), defaultToolPermissions: { delete_file: true } } as any)).rejects.toThrow()
  const agent = await service.create({ ...input(), isBuiltin: true, apiKey: 'INJECTED_KEY' } as any)
  expect(agent.isBuiltin).toBe(false)
  expect(JSON.stringify(await service.get(agent.id))).not.toContain('INJECTED_KEY')
  await expect(service.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: 'yes', modelConfigOverrideId: null, toolPermissionsOverride: null } as any)).rejects.toThrow()
  await expect(service.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: { write_file: true } })).rejects.toThrow('群聊权限不能超出 Agent 默认权限')
  expect(await service.listChannelAgents(channelId)).toEqual([])
})

it('exposes CRUD through named IPC with no prompt in summary responses or model credentials in any response', async () => {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>()
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, dialog: { showOpenDialog: vi.fn() }, repositories })
  const invoke = async (channel: IpcChannel, ...args: unknown[]) => handlers.get(channel)!(undefined, ...args) as any
  const agent = await invoke(IpcChannel.AgentCreate, input())
  const updated = await invoke(IpcChannel.AgentUpdate, agent.id, { ...input(), name: 'Updated' })
  expect(await invoke(IpcChannel.AgentList)).toEqual([updated])
  expect(JSON.stringify(updated)).not.toContain('PRIVATE_PROMPT')
  const editor = await invoke(IpcChannel.AgentGet, agent.id)
  expect(editor.systemPrompt).toBe('PRIVATE_PROMPT')
  expect(JSON.stringify(editor)).not.toContain('PRIVATE_KEY')
  await invoke(IpcChannel.ChannelAgentSave, { channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  expect(await invoke(IpcChannel.ChannelAgentList, channelId)).toHaveLength(1)
  await invoke(IpcChannel.ChannelAgentRemove, channelId, agent.id)
  await invoke(IpcChannel.AgentRemove, agent.id)
  expect(await invoke(IpcChannel.AgentList)).toEqual([])
})

it('migrates existing v3 databases idempotently and enforces the single-enabled rule in SQLite', () => {
  const sqlite = new Database(':memory:')
  try {
    migrate(sqlite)
    sqlite.exec("INSERT INTO projects VALUES ('p', 'project', NULL, 'C:/test', 'now', 'now'); INSERT INTO channels VALUES ('c', 'p', 'channel', NULL, 'now', 'now');")
    sqlite.exec('DROP TABLE tool_executions; ALTER TABLE task_runs DROP COLUMN generation; DROP TABLE channel_agents; DROP TABLE agents; PRAGMA user_version = 3;')
    migrate(sqlite)
    migrate(sqlite)
    expect(sqlite.prepare('SELECT name FROM projects').get()).toEqual({ name: 'project' })
    sqlite.exec("INSERT INTO model_configs VALUES ('m', 'openai', 'https://example.test', 'test', 'key', 'now', 'now');")
    const insert = sqlite.prepare('INSERT INTO agents VALUES (?, ?, NULL, ?, ?, ?, ?, 0, ?, ?)')
    for (const id of ['a', 'b']) insert.run(id, id, 'title', 'prompt', 'm', '{}', 'now', 'now')
    sqlite.exec("INSERT INTO channel_agents VALUES ('c', 'a', 1, NULL, NULL, 'now', 'now');")
    expect(() => sqlite.exec("INSERT INTO channel_agents VALUES ('c', 'b', 1, NULL, NULL, 'now', 'now');")).toThrow(/UNIQUE/)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(7)
  } finally {
    sqlite.close()
  }
})
