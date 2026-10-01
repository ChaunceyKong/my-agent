import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'
import { createDatabase } from '../../electron/database/client'
import { createRepositories } from '../../electron/database/repositories'
import { migrate } from '../../electron/database/schema'

it('migrates real v10 shaped rows, pauses duplicate running runs and keeps legacy provenance', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`
      PRAGMA user_version = 10;
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, icon TEXT, workspace_path TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE channels (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), name TEXT, icon TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE task_runs (id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id), model_config_id TEXT, status TEXT CHECK (status IN ('queued','running','cancelled','failed','completed','paused')), generation INTEGER, started_at TEXT, finished_at TEXT, error_message TEXT, created_at TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id), task_run_id TEXT REFERENCES task_runs(id), role TEXT, author_name TEXT, content TEXT, status TEXT, created_at TEXT);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id), task_run_id TEXT REFERENCES task_runs(id), event_type TEXT, metadata_json TEXT, created_at TEXT);
      CREATE TABLE model_configs (id TEXT PRIMARY KEY);
      CREATE TABLE agents (id TEXT PRIMARY KEY);
      CREATE TABLE tool_executions (id TEXT PRIMARY KEY);
      CREATE TABLE channel_agents (channel_id TEXT, agent_id TEXT, is_enabled INTEGER, PRIMARY KEY(channel_id,agent_id));
      CREATE UNIQUE INDEX channel_agents_one_enabled_idx ON channel_agents(channel_id) WHERE is_enabled=1;
      INSERT INTO projects VALUES ('p','p',NULL,'C:/work','now','now');
      INSERT INTO channels VALUES ('c','p','c',NULL,'now','now');
      INSERT INTO task_runs VALUES ('r1','c','m','running',0,'now',NULL,NULL,'now');
      INSERT INTO task_runs VALUES ('r2','c','m','running',0,'now',NULL,NULL,'now');
      INSERT INTO messages VALUES ('old','c','r1','agent','AI','private reply','completed','now');
    `)
    migrate(sqlite)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(11)
    expect(sqlite.prepare('SELECT id,status,generation,pause_reason FROM task_runs ORDER BY id').all()).toEqual([
      { id: 'r1', status: 'paused', generation: 1, pause_reason: 'migration_duplicate_running' },
      { id: 'r2', status: 'paused', generation: 1, pause_reason: 'migration_duplicate_running' },
    ])
    expect(sqlite.prepare('SELECT agent_id,origin,task_run_seq,content FROM messages').get()).toEqual({ agent_id: null, origin: 'legacy', task_run_seq: null, content: 'private reply' })
    expect(sqlite.prepare('SELECT event_type,metadata_json FROM audit_events ORDER BY task_run_id').all()).toHaveLength(2)
    expect(() => sqlite.exec("UPDATE task_runs SET status='running' WHERE id='r1'; UPDATE task_runs SET status='running' WHERE id='r2'")) .toThrow(/UNIQUE/)
    migrate(sqlite)
    expect(sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 2 })
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='channel_agents_one_enabled_idx'").get()).toBeTruthy()
  } finally { sqlite.close() }
})

it('allocates ordered events, admits one Turn and pauses it on restart without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-v03-foundation-'))
  const filePath = join(directory, 'db.sqlite')
  let db = createDatabase({ filePath })
  try {
    let repositories = createRepositories(db)
    const { channel } = await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: directory })
    const model = await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'encrypted' })
    const agent = await repositories.createAgent({ name: 'A', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id, defaultToolPermissions: {} })
    await repositories.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    const run = await repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'private CEO body' })
    await expect(repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'new' })).rejects.toThrow()
    const extra = await Promise.all(Array.from({ length: 12 }, () => repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided')))
    expect(extra.map((event) => event.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 2))
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, extra[0].seq)
    await expect(repositories.startAgentTurn(run.id, run.generation, agent.id, extra[0].seq)).rejects.toThrow()
    expect(turn.ordinal).toBe(1)
    expect(JSON.stringify(await repositories.listTaskRunEvents(run.id))).not.toContain('private CEO body')
    db.close()
    db = createDatabase({ filePath })
    repositories = createRepositories(db)
    expect(await repositories.recoverRunningTaskRuns()).toBe(1)
    expect(await repositories.getTaskRun(run.id)).toMatchObject({ status: 'paused', generation: 1, currentTurnId: null, turnCount: 1 })
    expect(await repositories.listAgentTurns(run.id)).toMatchObject([{ id: turn.id, status: 'cancelled' }])
    await expect(repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'blocked' })).rejects.toThrow()
    expect(await repositories.recoverRunningTaskRuns()).toBe(0)
    expect((await repositories.listTaskRunEvents(run.id)).map((event) => event.seq)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1))
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('commits Agent message, identity and completion event in one Turn transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-v03-turn-'))
  const db = createDatabase({ filePath: join(directory, 'db.sqlite') })
  try {
    const repositories = createRepositories(db)
    const { channel } = await repositories.createProjectWithInitialChannel({ name: 'test', workspacePath: directory })
    const model = await repositories.saveModelConfig({ providerPreset: 'openai', baseUrl: 'https://example.test', modelName: 'test', encryptedApiKey: 'encrypted' })
    const agent = await repositories.createAgent({ name: 'A', avatar: null, title: '', systemPrompt: '', modelConfigId: model.id, defaultToolPermissions: {} })
    await repositories.saveChannelAgent({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
    const run = await repositories.createStartedTaskRun({ channelId: channel.id, modelConfigId: model.id, content: 'CEO secret' })
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, 1)
    await expect(repositories.completeAgentTurn(turn.id, '   ')).rejects.toThrow()
    expect(await repositories.listAgentTurns(run.id)).toMatchObject([{ status: 'running' }])
    const completed = await repositories.completeAgentTurn(turn.id, 'Agent private reply')
    expect(completed.message).toMatchObject({ agentId: agent.id, origin: 'agent', status: 'completed', taskRunSeq: 3 })
    expect(completed.turn).toMatchObject({ status: 'completed', messageId: completed.message.id })
    expect((await repositories.listTaskRunEvents(run.id)).map((event) => [event.seq, event.eventType, event.messageId])).toEqual([
      [1, 'ceo_message', expect.any(String)], [2, 'turn_started', null], [3, 'turn_completed', completed.message.id],
    ])
    expect(JSON.stringify(await repositories.listTaskRunEvents(run.id))).not.toMatch(/CEO secret|Agent private reply/)
    await expect(repositories.completeAgentTurn(turn.id, 'late reply')).rejects.toThrow()
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
