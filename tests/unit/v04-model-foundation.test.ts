import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, modelFingerprint, type Repositories } from '../../electron/database/repositories'
import { migrate, schema } from '../../electron/database/schema'
import { createModelClient } from '../../electron/core/model-client'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'

let db: DatabaseClient | undefined
afterEach(() => { db?.close(); db = undefined })
function setup() {
  db = createDatabase({ filePath: ':memory:' })
  return createRepositories(db)
}
const input = (name: string, fallbackConfigId?: string | null) => ({ providerPreset: 'openai' as const, baseUrl: 'https://example.test',
  modelName: name, encryptedApiKey: 'ENCRYPTED_PRIVATE_KEY', fallbackConfigId })
async function turnFixture(repo: Repositories) {
  const { project, channel } = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: 'C:/test' })
  const backup = await repo.saveModelConfig(input('backup'))
  const primary = await repo.saveModelConfig(input('primary', backup.id))
  const agent = await repo.createAgent({ name: 'A', avatar: null, title: '', systemPrompt: '', modelConfigId: primary.id,
    defaultToolPermissions: { read_file: true, write_file: true, run_process: true } })
  const member = await repo.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
  const run = await repo.createStartedTaskRun({ channelId: channel.id, modelConfigId: primary.id, content: 'goal' })
  const turn = (await repo.startSingleMemberTurn(run.id, run.generation))!
  return { project, channel, primary, backup, agent, member, run, turn }
}

it('validates every upstream chain and leaves configuration and consents untouched on an invalid edit', async () => {
  const repo = setup()
  const { project } = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: 'C:/test' })
  const d = await repo.saveModelConfig(input('d'))
  const c = await repo.saveModelConfig(input('c'))
  const b = await repo.saveModelConfig(input('b', c.id))
  const a = await repo.saveModelConfig(input('a', b.id))
  await repo.recordCloudConsent(project.id, c.id); await repo.recordToolResultConsent(project.id, c.id, 1)
  await expect(repo.updateModelConfig(c.id, input('changed', d.id))).rejects.toThrow('两级')
  expect(await repo.getModelConfig(c.id)).toEqual(c)
  expect(await repo.hasCloudConsent(project.id, c.id)).toBe(true)
  expect(await repo.hasToolResultConsent(project.id, c.id, 1)).toBe(true)
  await expect(repo.updateModelConfig(c.id, input('cycle', a.id))).rejects.toThrow()
  await expect(repo.updateModelConfig(a.id, input('self', a.id))).rejects.toThrow('循环')
  await expect(repo.saveModelConfig(input('bad', 'missing'))).rejects.toThrow('不存在')
  await expect(repo.saveModelConfig(input('bad', ''))).rejects.toThrow('无效')
  expect((await repo.listModelConfigs()).map((config) => config.id)).toHaveLength(4)
  expect((await repo.getModelFallbackChain(a.id)).map((config) => config.id)).toEqual([a.id, b.id, c.id])
  await expect(repo.removeModelConfig(c.id)).rejects.toThrow('备选模型引用')
  await repo.updateModelConfig(b.id, input('same'))
  expect((await repo.getModelConfig(b.id))?.fallbackConfigId).toBe(c.id)
  await repo.updateModelConfig(b.id, input('clear', null))
  await repo.removeModelConfig(c.id)
})

it('returns safe fallback summaries without keys and preserves an omitted fallback during blank-key edits', async () => {
  const repo = setup()
  const client = createModelClient({ repositories: repo, consent: createCloudConsentService(repo),
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() },
    taskRuns: { canAcceptChunk: async () => true, onCancelled: () => () => {} } })
  const backup = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'backup', apiKey: 'PRIVATE_KEY' })
  const primary = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'primary', apiKey: 'PRIVATE_KEY', fallbackConfigId: backup.id })
  const edited = await client.saveModelConfig({ id: primary.id, providerPreset: 'openai', modelName: 'edited', apiKey: '' })
  expect(edited.fallbackConfigId).toBe(backup.id)
  expect(JSON.stringify(await client.listModelConfigs())).not.toMatch(/PRIVATE_KEY|encryptedApiKey|UFJJVkFURV9LRVk=/)
  await expect(client.saveModelConfig({ id: primary.id, providerPreset: 'openai', modelName: 'bad', apiKey: '', fallbackConfigId: primary.id })).rejects.toThrow('循环')
  expect((await repo.getModelConfig(primary.id))?.modelName).toBe('edited')
})

it('binds actual model tools and completed output while public snapshots omit Main fingerprints', async () => {
  const repo = setup(); const f = await turnFixture(repo)
  const binding = { turnId: f.turn.id, configuredModelSnapshot: JSON.stringify(f.primary), actualModelSnapshot: JSON.stringify(f.backup), memberRevision: f.member.revision }
  await expect(repo.bindAgentTurnModel(binding)).rejects.toThrow('未授权')
  await repo.recordCloudConsent(f.project.id, f.backup.id)
  await expect(repo.bindAgentTurnModel({ ...binding, hasToolObservations: true })).rejects.toThrow('未授权')
  await repo.recordToolResultConsent(f.project.id, f.backup.id, 1)
  const bound = await repo.bindAgentTurnModel({ ...binding, hasToolObservations: true })
  expect(bound).toMatchObject({ configuredModelConfigId: f.primary.id, actualModelConfigId: f.backup.id, actualModelFingerprint: modelFingerprint(f.backup) })
  const execution = await repo.createToolExecution({ taskRunId: f.run.id, generation: f.run.generation, agentId: f.agent.id, turnId: f.turn.id }, { toolName: 'read_file', input: { path: 'a.md' } })
  expect(JSON.parse(execution.policySnapshotJson)).toMatchObject({ version: 2, actualModelConfigId: f.backup.id, modelFingerprint: modelFingerprint(f.backup), turnId: f.turn.id })
  expect(execution.policySnapshotJson).not.toContain('ENCRYPTED_PRIVATE_KEY')
  await expect(repo.bindAgentTurnModel({ ...binding, actualModelSnapshot: JSON.stringify(f.primary) })).rejects.toThrow()
  await repo.finishToolExecution(execution.id, () => ({ status: 'completed', riskLevel: 'low', resultSummary: 'done' }))
  expect((await repo.completeAgentTurn(f.turn.id, 'answer')).message.actualModelConfigId).toBe(f.backup.id)
  expect((await repo.getTaskRun(f.run.id))?.modelConfigId).toBe(f.primary.id)
  const snapshot = await repo.getChannelTaskSnapshot(f.channel.id)
  expect(snapshot.turns[0]).toMatchObject({ configuredModelConfigId: f.primary.id, actualModelConfigId: f.backup.id })
  expect(JSON.stringify(snapshot)).not.toMatch(/Fingerprint|ENCRYPTED_PRIVATE_KEY/)
})

it('rejects model or member revocation and invalidates an unclaimed approval after actual model edit', async () => {
  const repo = setup(); const f = await turnFixture(repo)
  await repo.recordCloudConsent(f.project.id, f.backup.id)
  const binding = { turnId: f.turn.id, configuredModelSnapshot: JSON.stringify(f.primary), actualModelSnapshot: JSON.stringify(f.backup), memberRevision: f.member.revision }
  await repo.bindAgentTurnModel(binding)
  const execution = await repo.createToolExecution({ taskRunId: f.run.id, generation: f.run.generation, agentId: f.agent.id, turnId: f.turn.id }, { toolName: 'write_file', input: { path: 'a.md', content: 'text' } })
  const approval = await repo.createApprovalRequest(execution.id, new Date(Date.now() + 60_000).toISOString())
  await repo.updateModelConfig(f.backup.id, input('edited'))
  expect((await repo.getToolExecution(execution.id))?.status).toBe('cancelled')
  expect((await repo.getApprovalRequest(approval.id))?.status).toBe('cancelled')
  await expect(repo.completeAgentTurn(f.turn.id, 'late')).rejects.toThrow('模型绑定')
  await expect(repo.bindAgentTurnModel(binding)).rejects.toThrow('失效')
  const currentBackup = (await repo.getModelConfig(f.backup.id))!
  await repo.recordCloudConsent(f.project.id, f.backup.id)
  await repo.saveChannelAgent({ ...f.member, toolPermissionsOverride: {} })
  await expect(repo.bindAgentTurnModel({ ...binding, actualModelSnapshot: JSON.stringify(currentBackup) })).rejects.toThrow('失效')
})

it.each(['chat', 'speaker', 'summary'] as const)('rechecks snapshot and consent after the Main-only selected-model callback for %s', async (kind) => {
  const repo = setup()
  const { project } = await repo.createProjectWithInitialChannel({ name: 'p', workspacePath: 'C:/test' })
  const config = await repo.saveModelConfig(input('primary'))
  await repo.recordCloudConsent(project.id, config.id)
  const fetch = vi.fn()
  const client = createModelClient({ repositories: repo, consent: createCloudConsentService(repo), fetch,
    crypto: { isEncryptionAvailable: () => true, encryptString: (key) => Buffer.from(key), decryptString: (key) => key.toString() },
    taskRuns: { canAcceptChunk: async () => true, onCancelled: () => () => {} } })
  const selected = vi.fn(async (selection) => {
    expect(selection).toEqual({ configuredModelConfigId: config.id, actualModelConfigId: config.id, modelSnapshot: JSON.stringify(config) })
    await repo.updateModelConfig(config.id, input('changed'))
  })
  const request = { projectId: project.id, modelConfigId: config.id, taskRunId: 'r', prompt: 'data' }
  const pending = kind === 'chat' ? client.streamChat({ ...request, messages: [{ role: 'user', content: 'data' }] }, () => {}, async () => true, selected)
    : kind === 'speaker' ? client.selectSpeaker(request, async () => true, selected) : client.summarizeSession(request, async () => true, selected)
  await expect(pending).rejects.toThrow()
  expect(selected).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled()
})

it('upgrades populated v16 without invented provenance or releasing claimed process/file cleanup barriers', async () => {
  const sqlite = new Database(':memory:')
  try {
    migrate(sqlite)
    sqlite.exec(`ALTER TABLE agents DROP COLUMN source_template_id;
      ALTER TABLE model_configs DROP COLUMN fallback_config_id;
      ALTER TABLE agent_turns DROP COLUMN configured_model_config_id;
      ALTER TABLE agent_turns DROP COLUMN actual_model_config_id;
      ALTER TABLE agent_turns DROP COLUMN configured_model_fingerprint;
      ALTER TABLE agent_turns DROP COLUMN actual_model_fingerprint;
      ALTER TABLE agent_turns DROP COLUMN member_revision;
      ALTER TABLE messages DROP COLUMN actual_model_config_id;
      ALTER TABLE session_summaries DROP COLUMN configured_model_config_id;
      PRAGMA user_version=16;
      INSERT INTO projects VALUES ('p','p',NULL,'C:/test','now','now');
      INSERT INTO model_configs VALUES ('m','openai','https://example.test','test','ENCRYPTED_PRIVATE_KEY',8192,1024,'now','now');
      INSERT INTO channels (id,project_id,name,created_at,updated_at) VALUES ('c','p','c','now','now');
      INSERT INTO agents VALUES ('a','A',NULL,'title','prompt','m','{}',0,'now','now');
      INSERT INTO task_runs (id,channel_id,model_config_id,status,created_at) VALUES ('r','c','m','running','now');
      INSERT INTO agent_turns (id,task_run_id,ordinal,agent_id,generation,status,trigger_event_seq) VALUES ('t','r',1,'a',0,'running',1);
      INSERT INTO messages (id,channel_id,task_run_id,role,author_name,content,status,created_at) VALUES ('msg','c','r','agent','A','historical','completed','now');
      INSERT INTO cloud_consents VALUES ('p','m','now');
      INSERT INTO tool_result_consents VALUES ('p','m',1,'now');`)
    const insertTool = sqlite.prepare(`INSERT INTO tool_executions (id,task_run_id,generation,agent_id,tool_name,input_json,risk_level,request_hash,policy_snapshot_json,status,created_at,updated_at)
      VALUES (?,'r',0,'a',?,'{}','medium','hash',?,?,'now','now')`)
    insertTool.run('pending', 'write_file', '{"version":1}', 'waiting_approval')
    insertTool.run('malformed', 'read_file', 'invalid json', 'executing')
    insertTool.run('process', 'run_process', '{"version":1}', 'executing')
    insertTool.run('file', 'replace_file_content', '{"version":1}', 'executing')
    const insertApproval = sqlite.prepare(`INSERT INTO approval_requests VALUES (?,?, 'hash',0,'{"version":1}',?,'later',NULL,'now')`)
    insertApproval.run('ap', 'pending', 'pending'); insertApproval.run('ac', 'process', 'executing'); insertApproval.run('af', 'file', 'executing')
    sqlite.exec("INSERT INTO overwrite_publications VALUES ('file','temporary','backup',NULL,'cleanup_pending','now','now')")
    migrate(sqlite); migrate(sqlite)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(18)
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(sqlite.prepare('SELECT encrypted_api_key,fallback_config_id FROM model_configs').get()).toEqual({ encrypted_api_key: 'ENCRYPTED_PRIVATE_KEY', fallback_config_id: null })
    expect(sqlite.prepare('SELECT configured_model_config_id,actual_model_config_id FROM agent_turns').get()).toEqual({ configured_model_config_id: null, actual_model_config_id: null })
    expect(sqlite.prepare('SELECT actual_model_config_id FROM messages').get()).toEqual({ actual_model_config_id: null })
    expect(sqlite.prepare('SELECT id,status FROM tool_executions ORDER BY id').all()).toEqual([
      { id: 'file', status: 'executing' }, { id: 'malformed', status: 'cancelled' }, { id: 'pending', status: 'cancelled' }, { id: 'process', status: 'executing' },
    ])
    expect(sqlite.prepare('SELECT id,status FROM approval_requests ORDER BY id').all()).toEqual([
      { id: 'ac', status: 'executing' }, { id: 'af', status: 'executing' }, { id: 'ap', status: 'cancelled' },
    ])
    expect(sqlite.prepare('SELECT state FROM overwrite_publications').get()).toEqual({ state: 'cleanup_pending' })
    expect(sqlite.prepare('SELECT event_type FROM audit_events').all()).toHaveLength(2)
    expect(sqlite.prepare('SELECT * FROM cloud_consents').all()).toHaveLength(1)
    expect(sqlite.prepare('SELECT * FROM tool_result_consents').all()).toHaveLength(1)
    const repo = createRepositories({ db: drizzle(sqlite, { schema }), close: () => {} })
    await repo.beginTaskRunCancellation('r', 0)
    expect((await repo.settleTaskRunCancellation('r', true)).status).toBe('paused')
    await expect(repo.createStartedTaskRun({ channelId: 'c', modelConfigId: 'm', content: 'new' })).rejects.toThrow()
  } finally { sqlite.close() }
})
