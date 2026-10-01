import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createToolEngine } from '../../electron/core/tool-engine'
import { createApprovalService } from '../../electron/core/approval-service'
import { migrate } from '../../electron/database/schema'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, linkSync: vi.fn(actual.linkSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fsp>()
  return { ...actual, open: vi.fn(actual.open) }
})

let directory: string
let root: string
let db: DatabaseClient
let repositories: Repositories
let context: { taskRunId: string; agentId: string; generation: number }
let channelId: string
let engine: ReturnType<typeof createToolEngine>

beforeEach(async () => {
  vi.clearAllMocks()
  directory = await fsp.mkdtemp(join(tmpdir(), 'agent-team-tool-engine-'))
  root = join(directory, 'workspace')
  await fsp.mkdir(join(root, 'drafts'), { recursive: true })
  db = createDatabase({ filePath: join(directory, 'db.sqlite') })
  repositories = createRepositories(db)
  const { channel } = await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: root })
  channelId = channel.id
  const model = await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.com', modelName: 'test', encryptedApiKey: 'encrypted' })
  const agent = await repositories.createAgent({ name: 'writer', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id,
    defaultToolPermissions: { write_file: true, read_file: true, list_dir: true, search_files: true } })
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const run = await repositories.createStartedTaskRun({ channelId, modelConfigId: model.id, content: 'write' })
  context = { taskRunId: run.id, agentId: agent.id, generation: run.generation }
  engine = createToolEngine(repositories, createApprovalService(repositories))
})

afterEach(async () => {
  vi.restoreAllMocks()
  db?.close()
  await fsp.rm(directory, { recursive: true, force: true })
})

const request = (content = 'private draft body') => ({ toolName: 'write_file', input: { path: 'drafts/article.md', content } })

it('publishes a complete new file atomically and persists safe hash/policy/audit records', async () => {
  const realLink = (await vi.importActual<typeof fs>('node:fs')).linkSync
  vi.mocked(fs.linkSync).mockImplementationOnce((source, target) => {
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readFileSync(source, 'utf8')).toBe('private draft body')
    realLink(source, target)
  })
  const { execution } = await engine.execute(context, request())
  expect(execution).toMatchObject({ status: 'completed', riskLevel: 'medium', generation: 0, toolName: 'write_file' })
  expect(execution.requestHash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.parse(execution.policySnapshotJson)).toMatchObject({ workspacePath: root, agentId: context.agentId })
  expect(await fsp.readFile(join(root, 'drafts/article.md'), 'utf8')).toBe('private draft body')
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual(['article.md'])
  expect(await repositories.getToolExecution(execution.id)).toEqual(execution)
  const events = await repositories.listAuditEvents(channelId)
  expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(['tool_executing', 'tool_completed']))
  expect(JSON.stringify(events)).not.toContain('private draft body')
  expect(JSON.stringify(events)).not.toContain(root.replaceAll('\\', '\\\\'))
})

it('uses path identity after binding the open temporary handle on Windows', async () => {
  const realOpen = (await vi.importActual<typeof fsp>('node:fs/promises')).open
  vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
    const file = await realOpen(...args)
    const stat = file.stat.bind(file)
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => ({ ...(await stat()), dev: 0 } as fs.Stats))
    return file
  })
  const { execution } = await engine.execute(context, request())
  expect(execution.status).toBe('completed')
  expect(await fsp.readFile(join(root, 'drafts/article.md'), 'utf8')).toBe('private draft body')
})

it('requires approval for an existing file without changing it', async () => {
  await fsp.writeFile(join(root, 'drafts/article.md'), 'original')
  const { execution } = await engine.execute(context, request())
  expect(execution).toMatchObject({ status: 'waiting_approval', riskLevel: 'high' })
  expect(await fsp.readFile(join(root, 'drafts/article.md'), 'utf8')).toBe('original')
  expect(fs.linkSync).not.toHaveBeenCalled()
})

it('routes replace_file_content through the same explicit overwrite approval and never creates a missing target', async () => {
  const target = join(root, 'drafts/article.md')
  await fsp.writeFile(target, 'original')
  const missing = await engine.execute(context, { toolName: 'replace_file_content', input: { path: 'drafts/missing.md', content: 'replacement' } })
  expect(missing.execution).toMatchObject({ status: 'failed' })
  await expect(fsp.access(join(root, 'drafts/missing.md'))).rejects.toThrow()
  const replacement = await engine.execute(context, { toolName: 'replace_file_content', input: { path: 'drafts/article.md', content: 'replacement' } })
  expect(replacement.execution).toMatchObject({ toolName: 'replace_file_content', status: 'waiting_approval', riskLevel: 'high' })
  expect(await fsp.readFile(target, 'utf8')).toBe('original')
  expect(await repositories.getApprovalForToolExecution(replacement.execution.id)).toMatchObject({ requestHash: replacement.execution.requestHash, status: 'pending' })
})

it('maps replace_file_content authority to write_file rather than an independent permission', async () => {
  const agent = (await repositories.getAgent(context.agentId))!
  await repositories.updateAgent(agent.id, { ...agent, defaultToolPermissions: { ...agent.defaultToolPermissions, write_file: false, replace_file_content: true } })
  await expect(engine.execute(context, { toolName: 'replace_file_content', input: { path: 'drafts/article.md', content: 'replacement' } })).rejects.toThrow('工具未授权')
  await repositories.updateAgent(agent.id, { ...agent, defaultToolPermissions: { ...agent.defaultToolPermissions, write_file: true, replace_file_content: false } })
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: { write_file: false, replace_file_content: true } })
  await expect(engine.execute(context, { toolName: 'replace_file_content', input: { path: 'drafts/article.md', content: 'replacement' } })).rejects.toThrow('工具未授权')
  await repositories.saveChannelAgent({ channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: { write_file: true, replace_file_content: false } })
  await fsp.writeFile(join(root, 'drafts/article.md'), 'original')
  const execution = await engine.execute(context, { toolName: 'replace_file_content', input: { path: 'drafts/article.md', content: 'replacement' } })
  expect(execution.execution).toMatchObject({ status: 'waiting_approval' })
})

it('turns a target racing into existence at publication into pending approval', async () => {
  const realLink = (await vi.importActual<typeof fs>('node:fs')).linkSync
  vi.mocked(fs.linkSync).mockImplementationOnce((source, target) => {
    fs.writeFileSync(target, 'racer', { flag: 'wx' })
    realLink(source, target)
  })
  const { execution } = await engine.execute(context, request())
  expect(execution).toMatchObject({ status: 'waiting_approval', riskLevel: 'high' })
  expect(await fsp.readFile(join(root, 'drafts/article.md'), 'utf8')).toBe('racer')
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual(['article.md'])
})

it.each(['cancel', 'generation'] as const)('invalidates pending approvals on %s and rejects stale calls', async (action) => {
  await fsp.writeFile(join(root, 'drafts/article.md'), 'original')
  const { execution } = await engine.execute(context, request())
  const runs = createTaskRunService(repositories)
  if (action === 'cancel') await runs.cancelTaskRun(context.taskRunId)
  else await runs.advanceGeneration(context.taskRunId)
  expect(await repositories.getToolExecution(execution.id)).toMatchObject({ status: 'cancelled' })
  await expect(engine.execute(context, request())).rejects.toThrow()
  expect(await fsp.readFile(join(root, 'drafts/article.md'), 'utf8')).toBe('original')
})

it('cancellation while a temp file is being flushed prevents publication and cleans up', async () => {
  const realOpen = (await vi.importActual<typeof fsp>('node:fs/promises')).open
  vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
    const file = await realOpen(...args)
    const sync = file.sync.bind(file)
    vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
      await sync()
      await createTaskRunService(repositories).cancelTaskRun(context.taskRunId)
    })
    return file
  })
  const { execution } = await engine.execute(context, request())
  expect(execution.status).toBe('cancelled')
  expect(fs.linkSync).not.toHaveBeenCalled()
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual([])
})

it('does not audit read/search bodies or final task text', async () => {
  await fsp.writeFile(join(root, 'drafts/article.md'), 'private draft body')
  const result = await engine.execute(context, { toolName: 'read_file', input: { path: 'drafts/article.md' } })
  expect(result.result).toMatchObject({ content: 'private draft body' })
  await engine.execute(context, { toolName: 'search_files', input: { path: '.', query: 'private' } })
  await createTaskRunService(repositories).finishTaskRun(context.taskRunId, 'private draft body')
  expect(JSON.stringify(await repositories.listAuditEvents(channelId))).not.toContain('private')
})

it.each(['.env', '.git/config', '../escape.txt', 'drafts/key.pem'])('preserves sandbox denial for %s', async (path) => {
  const { execution } = await engine.execute(context, { toolName: 'write_file', input: { path, content: 'secret' } })
  expect(execution.status).toBe('failed')
  expect(fs.linkSync).not.toHaveBeenCalled()
})

it('rejects unknown fields, unknown tools and binary/oversized write payloads', async () => {
  for (const value of [
    { ...request(), workspacePath: root },
    { toolName: 'shell', input: {} },
    { toolName: 'write_file', input: { path: 'a', content: 'x', bypass: true } },
    request('\0binary'), request('x'.repeat(262145)),
  ]) await expect(engine.execute(context, value)).rejects.toThrow()
  expect(await repositories.listToolExecutions(context.taskRunId)).toEqual([])
})

it('enforces permission intersection and disabled membership', async () => {
  await repositories.saveChannelAgent({ channelId, agentId: context.agentId, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: {} })
  await expect(engine.execute(context, request())).rejects.toThrow()
  await repositories.saveChannelAgent({ channelId, agentId: context.agentId, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
  await expect(engine.execute(context, request())).rejects.toThrow()
  expect(fs.linkSync).not.toHaveBeenCalled()
})

it.each([
  ['executing', 'disable-reenable'], ['waiting_approval', 'disable-reenable'],
  ['executing', 'switch-back'], ['waiting_approval', 'switch-back'],
  ['executing', 'remove-readd'], ['waiting_approval', 'remove-readd'],
  ['executing', 'agent-permissions'], ['waiting_approval', 'agent-permissions'],
  ['executing', 'channel-permissions'], ['waiting_approval', 'channel-permissions'],
] as const)('permanently invalidates %s tools after %s even when the policy is restored', async (status, change) => {
  const agent = (await repositories.getAgent(context.agentId))!
  const member = { channelId, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null }
  const execution = await repositories.createToolExecution(context, { toolName: 'write_file', input: { path: 'drafts/article.md', content: 'private body' } })
  if (status === 'waiting_approval') {
    await repositories.finishToolExecution(execution.id, () => ({ status, riskLevel: 'high', resultSummary: '等待审批' }))
  }
  if (change === 'disable-reenable') {
    await repositories.saveChannelAgent({ ...member, isEnabled: false })
    await repositories.saveChannelAgent(member)
  } else if (change === 'switch-back') {
    const other = await repositories.createAgent({ name: 'other', avatar: null, title: '', systemPrompt: '', modelConfigId: agent.modelConfigId, defaultToolPermissions: { write_file: true } })
    await repositories.saveChannelAgent({ ...member, agentId: other.id })
    await repositories.saveChannelAgent(member)
  } else if (change === 'remove-readd') {
    await repositories.removeChannelAgent(channelId, agent.id)
    await repositories.saveChannelAgent(member)
  } else if (change === 'agent-permissions') {
    await repositories.updateAgent(agent.id, { ...agent, defaultToolPermissions: { ...agent.defaultToolPermissions, write_file: false } })
    await repositories.updateAgent(agent.id, agent)
  } else {
    await repositories.saveChannelAgent({ ...member, toolPermissionsOverride: { write_file: false } })
    await repositories.saveChannelAgent(member)
  }
  const callback = vi.fn(() => ({ status: 'completed' as const, riskLevel: 'medium' as const, resultSummary: 'done' }))
  expect((await repositories.finishToolExecution(execution.id, callback)).status).toBe('cancelled')
  expect(callback).not.toHaveBeenCalled()
  expect(await repositories.getToolExecution(execution.id)).toMatchObject({ status: 'cancelled' })
  const cancelled = (await repositories.listAuditEvents(channelId)).filter((event) => event.eventType === 'tool_cancelled')
  expect(cancelled).toHaveLength(1)
  expect(JSON.stringify(cancelled)).not.toContain('private body')
})

it('rolls back a membership revocation if its tool cancellation audit cannot be saved', async () => {
  const execution = await repositories.createToolExecution(context, { toolName: 'write_file', input: { path: 'drafts/article.md', content: 'body' } })
  const sqlite = new Database(join(directory, 'db.sqlite'))
  try {
    sqlite.exec("CREATE TRIGGER reject_cancel_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'tool_cancelled' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;")
    await expect(repositories.saveChannelAgent({ channelId, agentId: context.agentId, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })).rejects.toThrow('audit unavailable')
    expect((await repositories.listChannelAgents(channelId))[0].isEnabled).toBe(true)
    expect(await repositories.getToolExecution(execution.id)).toMatchObject({ status: 'executing' })
  } finally { sqlite.close() }
})

it('preserves an executing tool across a no-op membership save and an unrelated Agent edit', async () => {
  const execution = await repositories.createToolExecution(context, { toolName: 'write_file', input: { path: 'drafts/article.md', content: 'body' } })
  await repositories.saveChannelAgent({ channelId, agentId: context.agentId, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const agent = (await repositories.getAgent(context.agentId))!
  await repositories.updateAgent(agent.id, { ...agent, name: 'renamed' })
  const callback = vi.fn(() => ({ status: 'completed' as const, riskLevel: 'medium' as const, resultSummary: 'done' }))
  expect((await repositories.finishToolExecution(execution.id, callback)).status).toBe('completed')
  expect(callback).toHaveBeenCalledOnce()
})

it.each(['generation', 'permissions'] as const)('rechecks %s after staging a file and before publication', async (action) => {
  const realOpen = (await vi.importActual<typeof fsp>('node:fs/promises')).open
  vi.mocked(fsp.open).mockImplementationOnce(async (...args) => {
    const file = await realOpen(...args)
    const sync = file.sync.bind(file)
    vi.spyOn(file, 'sync').mockImplementationOnce(async () => {
      await sync()
      if (action === 'generation') await repositories.advanceTaskRunGeneration(context.taskRunId)
      else await repositories.saveChannelAgent({ channelId, agentId: context.agentId, isEnabled: false, modelConfigOverrideId: null, toolPermissionsOverride: null })
    })
    return file
  })
  expect((await engine.execute(context, request())).execution.status).toBe('cancelled')
  expect(fs.linkSync).not.toHaveBeenCalled()
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual([])
})

it('rejects junction parents, existing directories and absent parent directories', async () => {
  const outside = join(directory, 'outside')
  await fsp.mkdir(outside)
  await fsp.symlink(outside, join(root, 'alias'), 'junction')
  for (const path of ['alias/article.md', 'drafts', 'missing/article.md']) {
    expect((await engine.execute(context, { toolName: 'write_file', input: { path, content: 'secret' } })).execution.status).toBe('failed')
  }
  expect(await fsp.readdir(outside)).toEqual([])
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual([])
  expect(fs.linkSync).not.toHaveBeenCalled()
})

it('preserves a complete file and requests approval when two runs create the same target concurrently', async () => {
  const firstRun = (await repositories.getTaskRun(context.taskRunId))!
  const second = await repositories.createStartedTaskRun({ channelId, modelConfigId: firstRun.modelConfigId, content: 'second' })
  const results = await Promise.all([
    engine.execute(context, request('first content')),
    engine.execute({ ...context, taskRunId: second.id, generation: second.generation }, request('second content')),
  ])
  expect(results.map((result) => result.execution.status).sort()).toEqual(['completed', 'waiting_approval'])
  expect(['first content', 'second content']).toContain(await fsp.readFile(join(root, 'drafts/article.md'), 'utf8'))
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual(['article.md'])
})

it('serializes tools within a run and never executes a pending-approval callback', async () => {
  await fsp.writeFile(join(root, 'drafts/article.md'), 'original')
  const { execution } = await engine.execute(context, request())
  await expect(engine.execute(context, { toolName: 'list_dir', input: { path: '.' } })).rejects.toThrow('未完成')
  const callback = vi.fn(() => ({ status: 'completed' as const, riskLevel: 'high' as const, resultSummary: 'done' }))
  expect((await repositories.finishToolExecution(execution.id, callback)).status).toBe('waiting_approval')
  expect(callback).not.toHaveBeenCalled()
})

it('binds request hashes to content and generation and accepts only current generation chunks', async () => {
  const first = await engine.execute(context, request('first'))
  const second = await engine.execute(context, request('second'))
  expect(first.execution.requestHash).not.toBe(second.execution.requestHash)
  const runs = createTaskRunService(repositories)
  const next = await runs.advanceGeneration(context.taskRunId)
  const third = await engine.execute({ ...context, generation: next.generation }, request('second'))
  expect(third.execution.requestHash).not.toBe(second.execution.requestHash)
  expect(await runs.canAcceptChunk(context.taskRunId, context.generation)).toBe(false)
  expect(await runs.canAcceptChunk(context.taskRunId, next.generation)).toBe(true)
})

it('pauses interrupted runs and invalidates both staged and waiting tools without replay on restart', async () => {
  await fsp.writeFile(join(root, 'drafts/article.md'), 'original')
  const pending = await engine.execute(context, request())
  const run = (await repositories.getTaskRun(context.taskRunId))!
  const another = await repositories.createStartedTaskRun({ channelId, modelConfigId: run.modelConfigId, content: 'another' })
  const staged = await repositories.createToolExecution({ ...context, taskRunId: another.id }, { toolName: 'write_file', input: { path: 'drafts/new.md', content: 'body' } })
  db.close()
  db = createDatabase({ filePath: join(directory, 'db.sqlite') })
  repositories = createRepositories(db)
  expect(await repositories.recoverRunningTaskRuns()).toBe(2)
  expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', generation: 1 })
  for (const id of [pending.execution.id, staged.id]) expect(await repositories.getToolExecution(id)).toMatchObject({ status: 'cancelled' })
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual(['article.md'])
  expect(await repositories.recoverRunningTaskRuns()).toBe(0)
})

it('fails closed when atomic publication fails and records only a safe error', async () => {
  vi.mocked(fs.linkSync).mockImplementationOnce(() => { throw new Error('private body or absolute path from OS') })
  const { execution } = await engine.execute(context, request())
  expect(execution).toMatchObject({ status: 'failed', resultSummary: '工具执行失败 (PATH_UNAVAILABLE)' })
  expect(await fsp.readdir(join(root, 'drafts'))).toEqual([])
  expect(JSON.stringify(await repositories.listAuditEvents(channelId))).not.toContain('private')
})

it('migrates v4 runs with generation zero and preserves existing data on repeated migration', () => {
  const sqlite = new Database(':memory:')
  try {
    migrate(sqlite)
    sqlite.exec(`
      DROP TABLE tool_executions;
      ALTER TABLE task_runs DROP COLUMN generation;
      PRAGMA user_version = 4;
      INSERT INTO projects VALUES ('p', 'project', NULL, 'C:/test', 'now', 'now');
      INSERT INTO channels VALUES ('c', 'p', 'channel', NULL, 'now', 'now');
      INSERT INTO task_runs VALUES ('r', 'c', 'm', 'running', 'now', NULL, NULL, 'now');
    `)
    migrate(sqlite)
    migrate(sqlite)
    expect(sqlite.prepare('SELECT id, generation, status FROM task_runs').get()).toEqual({ id: 'r', generation: 0, status: 'running' })
    expect(sqlite.pragma('user_version', { simple: true })).toBe(10)
  } finally { sqlite.close() }
})

it('persists tool creation and its audit event in one transaction', async () => {
  const sqlite = new Database(join(directory, 'db.sqlite'))
  try {
    sqlite.exec("CREATE TRIGGER reject_tool_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'tool_executing' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;")
    await expect(engine.execute(context, request())).rejects.toThrow('audit unavailable')
    expect(await repositories.listToolExecutions(context.taskRunId)).toEqual([])
    expect(await fsp.readdir(join(root, 'drafts'))).toEqual([])
  } finally { sqlite.close() }
})
