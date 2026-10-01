import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentService } from '../../electron/core/agent-service'
import { getBuiltinTemplate } from '../../electron/core/builtin-templates'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { parseAgentMentions } from '../../electron/core/mention-parser'
import { createModelClient } from '../../electron/core/model-client'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createTemplateService } from '../../electron/core/template-service'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { agentTurns, approvalRequests, migrate, overwritePublications, schema, taskRuns as runTable, toolExecutions } from '../../electron/database/schema'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'
import type { CopyAgentTemplateInput, TaskRunStatus, ToolExecutionStatus } from '../../shared/types'

let database: DatabaseClient
let repositories: Repositories
let service: ReturnType<typeof createTemplateService>
let modelConfigId: string
let channelId: string

beforeEach(async () => {
  database = createDatabase({ filePath: ':memory:' })
  repositories = createRepositories(database)
  service = createTemplateService(repositories)
  modelConfigId = (await repositories.saveModelConfig({ providerPreset: 'openai', modelName: 'test',
    baseUrl: 'https://example.test', encryptedApiKey: 'PRIVATE_KEY' })).id
  channelId = (await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: 'C:/PRIVATE_WORKSPACE' })).channel.id
})

afterEach(() => { vi.restoreAllMocks(); database.close() })

const teamInput = (templateId = 'dev') => ({ templateId, channelId, modelConfigId })
const editor = () => ({ name: 'Custom Writer', avatar: '✍️', title: 'Custom Title', systemPrompt: 'CUSTOM_PROMPT', modelConfigId })
const copyInput = (): CopyAgentTemplateInput => ({ templateId: 'dev', roleId: 'developer', channelId, editor: editor() })
const savedState = async () => ({ agents: await repositories.listAgents(), members: await repositories.listChannelAgents(channelId) })

function ipc() {
  const handlers = new Map<string, (event: unknown, ...args: any[]) => any>()
  const taskRuns = createTaskRunService(repositories)
  const fetchImpl = vi.fn()
  const modelClient = createModelClient({ repositories, taskRuns, consent: createCloudConsentService(repositories), fetch: fetchImpl,
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() } })
  registerHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, repositories, taskRuns, modelClient,
    dialog: { showOpenDialog: vi.fn() } })
  const invoke = (channel: IpcChannel, ...args: unknown[]) => handlers.get(channel)!({ sender: { isDestroyed: () => false, send: vi.fn() } }, ...args)
  return { handlers, invoke, taskRuns, fetchImpl }
}

async function seedRun(status: TaskRunStatus = 'completed') {
  const agent = await repositories.createAgent({ ...editor(), defaultToolPermissions: {} })
  database.db.insert(runTable).values({ id: 'run', channelId, modelConfigId, status, createdAt: 'now' }).run()
  return agent
}

function seedTool(agentId: string, status: ToolExecutionStatus = 'completed', processRecoveryRequired = false) {
  database.db.insert(toolExecutions).values({ id: 'tool', taskRunId: 'run', generation: 0, agentId,
    toolName: 'run_process', inputJson: '{}', riskLevel: 'medium', requestHash: 'hash', policySnapshotJson: '{}',
    status, processRecoveryRequired, createdAt: 'now', updatedAt: 'now' }).run()
}

it.each([['media', 5], ['business', 5], ['literature', 5], ['dev', 4]] as const)(
  'imports the entire %s team as %i enabled, editable, permission-denied user copies', async (templateId, count) => {
    const original = getBuiltinTemplate(templateId)!
    const result = await service.importTeam(teamInput(templateId))
    expect(result.agents).toHaveLength(count)
    expect(result.members).toHaveLength(count)
    expect(result.agents.map((agent) => agent.name)).toEqual(original.roles.map((role) => role.name))
    for (const agent of result.agents) {
      expect(agent).toMatchObject({ isBuiltin: false, sourceTemplateId: templateId, modelConfigId, defaultToolPermissions: {} })
      expect(agent).not.toHaveProperty('systemPrompt')
      expect(result.members.find((member) => member.agentId === agent.id)).toMatchObject({
        channelId, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null,
      })
      expect(result.members.find((member) => member.agentId === agent.id)?.revision).toBeTruthy()
      expect((await repositories.getAgent(agent.id))?.systemPrompt).toBe(original.roles.find((role) => role.name === agent.name)!.systemPrompt)
    }
    expect(await repositories.listTaskRuns(channelId)).toEqual([])
    expect(await repositories.listMessages(channelId)).toEqual([])
    expect(getBuiltinTemplate(templateId)).toEqual(original)
  },
)

it('allocates globally unique repeated-import names that remain individually mentionable', async () => {
  const name = getBuiltinTemplate('dev')!.roles[0].name
  const existing = await repositories.createAgent({ ...editor(), name, defaultToolPermissions: {} })
  const first = await service.importTeam(teamInput())
  const second = await service.importTeam(teamInput())
  expect(first.agents[0].name).toBe(`${name} 2`)
  expect(second.agents[0].name).toBe(`${name} 3`)
  expect((await repositories.getAgent(existing.id))?.name).toBe(name)
  const agents = await repositories.listAgents()
  expect(new Set(agents.map((agent) => agent.name)).size).toBe(9)
  expect(parseAgentMentions(`@${first.agents[0].name} @${second.agents[0].name}`, 'other',
    await repositories.listChannelAgents(channelId), agents)).toEqual([first.agents[0].id, second.agents[0].id])
})

it('copies customized identity, prompt and model into existing Studio CRUD without mutating the catalog', async () => {
  const original = getBuiltinTemplate('dev')!
  const otherModel = await repositories.saveModelConfig({ providerPreset: 'ollama', modelName: 'local', baseUrl: 'http://localhost:11434', encryptedApiKey: '' })
  const input = { ...copyInput(), editor: { ...editor(), modelConfigId: otherModel.id } }
  const { agents, members } = await service.copyAgent(input)
  expect(agents).toHaveLength(1)
  expect(members).toHaveLength(1)
  expect(await repositories.getAgent(agents[0].id)).toMatchObject({ ...input.editor, sourceTemplateId: 'dev', isBuiltin: false, defaultToolPermissions: {} })
  const studio = createAgentService(repositories)
  await studio.update(agents[0].id, { ...input.editor, name: 'Edited', systemPrompt: 'EDITED_PROMPT', defaultToolPermissions: { read_file: true } })
  expect(await studio.get(agents[0].id)).toMatchObject({ name: 'Edited', systemPrompt: 'EDITED_PROMPT', sourceTemplateId: 'dev', isBuiltin: false })
  await studio.removeChannelAgent(channelId, agents[0].id)
  await studio.remove(agents[0].id)
  expect(getBuiltinTemplate('dev')).toEqual(original)
})

it('rejects invalid team references and malformed or permission-forging input without persisting any partial copy', async () => {
  for (const input of [null, [], {}, { ...teamInput(), templateId: 'missing' }, { ...teamInput(), modelConfigId: 'missing' },
    { ...teamInput(), channelId: 'missing' }, { ...teamInput(), templateId: '../dev' },
    { ...teamInput(), defaultToolPermissions: { run_process: true } }, { ...teamInput(), apiKey: 'FORGED_KEY' }]) {
    await expect(service.importTeam(input as any)).rejects.toThrow()
    expect(await savedState()).toEqual({ agents: [], members: [] })
  }
  for (const input of [null, {}, { ...copyInput(), roleId: 'missing' }, { ...copyInput(), templateId: 'missing' },
    { ...copyInput(), channelId: 'missing' }, { ...copyInput(), editor: { ...editor(), modelConfigId: 'missing' } },
    { ...copyInput(), editor: { ...editor(), name: ' ' } }, { ...copyInput(), editor: { ...editor(), name: '@Forged' } },
    { ...copyInput(), editor: { ...editor(), name: 'Bad\u0000Name' } }, { ...copyInput(), editor: { ...editor(), avatar: 'x'.repeat(17) } },
    { ...copyInput(), editor: { ...editor(), systemPrompt: 7 } },
    { ...copyInput(), editor: { ...editor(), defaultToolPermissions: { run_process: true } } },
    { ...copyInput(), editor: { ...editor(), sourceTemplateId: 'forged' } }, { ...copyInput(), isBuiltin: true }]) {
    await expect(service.copyAgent(input as any)).rejects.toThrow()
    expect(await savedState()).toEqual({ agents: [], members: [] })
  }
})

it('rolls back the entire team if SQLite rejects the second insert', async () => {
  database.db.run(sql.raw(`CREATE TRIGGER fail_second_template BEFORE INSERT ON agents
    WHEN (SELECT count(*) FROM agents) = 1 BEGIN SELECT RAISE(ABORT, 'injected second Agent failure'); END;`))
  await expect(service.importTeam(teamInput())).rejects.toThrow('injected second Agent failure')
  expect(await savedState()).toEqual({ agents: [], members: [] })
})

it('rolls back an earlier copy if a later role model fails transactional validation', async () => {
  await expect(repositories.createTemplateAgents({ templateId: 'dev', channelId,
    copies: [editor(), { ...editor(), name: 'Second', modelConfigId: 'missing' }] })).rejects.toThrow('模型配置不存在')
  expect(await savedState()).toEqual({ agents: [], members: [] })
})

it.each(['queued', 'running', 'paused', 'cancelling'] as const)('blocks import and copy while a Run is %s', async (status) => {
  await seedRun(status)
  const before = await savedState()
  await expect(service.importTeam(teamInput())).rejects.toThrow('请先结束当前任务')
  await expect(service.copyAgent(copyInput())).rejects.toThrow('请先结束当前任务')
  expect(await savedState()).toEqual(before)
})

it.each(['turn', 'executing-tool', 'waiting-tool', 'process-recovery', 'pending-approval', 'approved-approval', 'journal'] as const)(
  'retains the Channel barrier for terminal-Run %s records', async (barrier) => {
    const agent = await seedRun()
    if (barrier === 'turn') database.db.insert(agentTurns).values({ id: 'turn', taskRunId: 'run', ordinal: 1, agentId: agent.id,
      generation: 0, status: 'waiting_approval', triggerEventSeq: 1 }).run()
    else {
      seedTool(agent.id, barrier === 'executing-tool' ? 'executing' : barrier === 'waiting-tool' ? 'waiting_approval' : 'completed', barrier === 'process-recovery')
      if (barrier.endsWith('approval')) database.db.insert(approvalRequests).values({ id: 'approval', toolExecutionId: 'tool',
        requestHash: 'hash', generation: 0, policySnapshotJson: '{}', status: barrier === 'pending-approval' ? 'pending' : 'approved',
        expiresAt: 'later', createdAt: 'now' }).run()
      if (barrier === 'journal') database.db.insert(overwritePublications).values({ executionId: 'tool', temporaryRelativePath: 'temporary',
        backupRelativePath: 'backup', state: 'cleanup_pending', createdAt: 'now', updatedAt: 'now' }).run()
    }
    const before = await savedState()
    await expect(service.importTeam(teamInput())).rejects.toThrow('恢复记录')
    expect(await savedState()).toEqual(before)
  },
)

it('does not treat a historical claimed approval as live after the effect and journal have closed', async () => {
  const agent = await seedRun()
  seedTool(agent.id)
  database.db.insert(approvalRequests).values({ id: 'approval', toolExecutionId: 'tool', requestHash: 'hash', generation: 0,
    policySnapshotJson: '{}', status: 'executing', expiresAt: 'later', createdAt: 'now' }).run()
  database.db.insert(overwritePublications).values({ executionId: 'tool', temporaryRelativePath: 'temporary', backupRelativePath: 'backup',
    state: 'completed', createdAt: 'now', updatedAt: 'now' }).run()
  expect((await service.importTeam(teamInput())).agents).toHaveLength(4)
})

it('persists imported editable copies and memberships after database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-team-template-'))
  const filePath = join(directory, 'templates.sqlite')
  let persistent = createDatabase({ filePath })
  try {
    let repo = createRepositories(persistent)
    const model = await repo.saveModelConfig({ providerPreset: 'ollama', modelName: 'local', baseUrl: 'http://localhost:11434', encryptedApiKey: '' })
    const { channel } = await repo.createProjectWithInitialChannel({ name: 'persistent', workspacePath: directory })
    await createTemplateService(repo).importTeam({ templateId: 'business', channelId: channel.id, modelConfigId: model.id })
    const expectedAgents = await repo.listAgents()
    const expectedMembers = await repo.listChannelAgents(channel.id)
    persistent.close()
    persistent = createDatabase({ filePath })
    repo = createRepositories(persistent)
    expect(await repo.listAgents()).toEqual(expectedAgents)
    expect(await repo.listChannelAgents(channel.id)).toEqual(expectedMembers)
    expect(expectedAgents.every((agent) => agent.sourceTemplateId === 'business' && !agent.isBuiltin)).toBe(true)
  } finally { persistent.close(); await rm(directory, { recursive: true, force: true }) }
})

it('upgrades populated v17 with null source identity and preserves the existing user Agent and membership', async () => {
  const sqlite = new Database(':memory:')
  try {
    migrate(sqlite)
    const repo = createRepositories({ db: drizzle(sqlite, { schema }), close: () => {} })
    const model = await repo.saveModelConfig({ providerPreset: 'openai', modelName: 'preserved', baseUrl: 'https://example.test', encryptedApiKey: 'PRIVATE_KEY' })
    const { channel } = await repo.createProjectWithInitialChannel({ name: 'preserved', workspacePath: 'C:/preserved' })
    const agent = await repo.createAgent({ ...editor(), modelConfigId: model.id, defaultToolPermissions: { read_file: true } })
    const member = await repo.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    sqlite.exec('ALTER TABLE agents DROP COLUMN source_template_id; PRAGMA user_version=17;')
    migrate(sqlite); migrate(sqlite)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(18)
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(await repo.getAgent(agent.id)).toEqual({ ...agent, sourceTemplateId: null })
    expect(await repo.listChannelAgents(channel.id)).toEqual([member])
    expect((await repo.getModelConfig(model.id))?.encryptedApiKey).toBe('PRIVATE_KEY')
  } finally { sqlite.close() }
})

it('registers only exact named IPC, returns safe previews and imports without network calls or task starts', async () => {
  const { handlers, invoke, fetchImpl } = ipc()
  expect([...handlers.keys()].sort()).toEqual(Object.values(IpcChannel).filter((name) => name !== IpcChannel.MessageStream).sort())
  const summaries = await invoke(IpcChannel.TemplateList)
  const preview = await invoke(IpcChannel.TemplateGet, 'dev')
  const result = await invoke(IpcChannel.TemplateImport, teamInput())
  const copied = await invoke(IpcChannel.TemplateCopy, copyInput())
  expect(summaries).toHaveLength(4)
  expect(preview.roles).toHaveLength(4)
  expect(result.agents).toHaveLength(4)
  expect(copied.agents).toHaveLength(1)
  expect(JSON.stringify({ summaries, preview, result, copied })).not.toMatch(/PRIVATE_KEY|encryptedApiKey|PRIVATE_WORKSPACE|policySnapshotJson/)
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await repositories.listTaskRuns(channelId)).toEqual([])
  await expect(invoke(IpcChannel.TemplateGet, '../dev')).rejects.toThrow()
})

it('blocks both template actions and MessageSend while template startup awaits Main checks', async () => {
  const { invoke, fetchImpl } = ipc()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const list = repositories.listTaskRuns.bind(repositories)
  vi.spyOn(repositories, 'listTaskRuns').mockImplementationOnce(async (id) => { entered(); await gate; return list(id) })
  const importing = invoke(IpcChannel.TemplateImport, teamInput())
  await waiting
  await expect(invoke(IpcChannel.MessageSend, { channelId, modelConfigId, content: 'must not start' })).rejects.toThrow('已有任务正在运行')
  await expect(invoke(IpcChannel.TemplateCopy, copyInput())).rejects.toThrow('正在启动')
  release()
  expect((await importing).agents).toHaveLength(4)
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await repositories.listTaskRuns(channelId)).toEqual([])
})

it('checks live Main effects even when the persisted Run is terminal and allows import after proven closure', async () => {
  await seedRun()
  const { invoke, taskRuns } = ipc()
  let release!: () => void
  const effect = taskRuns.trackEffect('run', () => new Promise<void>((resolve) => { release = resolve }))
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const before = await savedState()
  await expect(invoke(IpcChannel.TemplateImport, teamInput())).rejects.toThrow('等待操作清理')
  expect(await savedState()).toEqual(before)
  release(); await effect
  expect((await invoke(IpcChannel.TemplateImport, teamInput())).agents).toHaveLength(4)
})

it.each(['model', 'channel'] as const)('rechecks %s deletion after asynchronous Main startup checks before transactional import', async (deleted) => {
  const { invoke, fetchImpl } = ipc()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.spyOn(repositories, 'listTaskRuns').mockImplementationOnce(async () => { entered(); await gate; return [] })
  const importing = invoke(IpcChannel.TemplateImport, teamInput())
  const rejected = expect(importing).rejects.toThrow(deleted === 'model' ? '模型配置不存在' : '群聊不存在')
  await waiting
  if (deleted === 'model') await repositories.removeModelConfig(modelConfigId)
  else await repositories.removeChannel(channelId)
  release(); await rejected
  expect(await savedState()).toEqual({ agents: [], members: [] })
  expect(fetchImpl).not.toHaveBeenCalled()
})
