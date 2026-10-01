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

it.each([3, 4])('upgrades original v%i schema with existing run and message through v11', (version) => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, icon TEXT, workspace_path TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE channels (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, icon TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE task_runs (id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, model_config_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','cancelled','failed','completed','paused')), started_at TEXT, finished_at TEXT, error_message TEXT, created_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL, role TEXT NOT NULL CHECK (role IN ('ceo','agent')), author_name TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('sent','streaming','completed','failed')), created_at TEXT NOT NULL);
      CREATE TABLE audit_events (id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL, event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE model_configs (id TEXT PRIMARY KEY NOT NULL, provider_preset TEXT NOT NULL CHECK (provider_preset IN ('openai','deepseek')), base_url TEXT NOT NULL, model_name TEXT NOT NULL, encrypted_api_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE cloud_consents (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE, consented_at TEXT NOT NULL, PRIMARY KEY(project_id,model_config_id));
      INSERT INTO projects VALUES ('p','project',NULL,'C:/work','now','now');
      INSERT INTO channels VALUES ('c','p','channel',NULL,'now','now');
      INSERT INTO model_configs VALUES ('m','openai','https://example.test','test','encrypted','now','now');
      INSERT INTO task_runs VALUES ('r','c','m','running','now',NULL,NULL,'now');
      INSERT INTO messages VALUES ('msg','c','r','agent','AI','historical reply','completed','now');
    `)
    if (version === 4) sqlite.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, avatar TEXT, title TEXT NOT NULL, system_prompt TEXT NOT NULL, model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT, default_tool_permissions TEXT NOT NULL, is_builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE channel_agents (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT, is_enabled INTEGER NOT NULL DEFAULT 0, model_config_override_id TEXT REFERENCES model_configs(id) ON DELETE RESTRICT, tool_permissions_override TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(channel_id,agent_id));
      CREATE UNIQUE INDEX channel_agents_one_enabled_idx ON channel_agents(channel_id) WHERE is_enabled=1;
      INSERT INTO agents VALUES ('a','A',NULL,'title','prompt','m','{}',0,'now','now');
      INSERT INTO channel_agents VALUES ('c','a',1,NULL,NULL,'now','now');
    `)
    sqlite.pragma(`user_version = ${version}`)
    migrate(sqlite)
    migrate(sqlite)
    expect(sqlite.pragma('user_version', { simple: true })).toBe(11)
    expect(sqlite.prepare('SELECT id,generation,status FROM task_runs').get()).toEqual({ id: 'r', generation: 0, status: 'running' })
    expect(sqlite.prepare('SELECT id,agent_id,origin,content FROM messages').get()).toEqual({ id: 'msg', agent_id: null, origin: 'legacy', content: 'historical reply' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 })
    if (version === 4) expect(sqlite.prepare('SELECT agent_id,is_enabled FROM channel_agents').get()).toEqual({ agent_id: 'a', is_enabled: 1 })
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
    const extra = await Promise.all(Array.from({ length: 12 }, () => repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: agent.id })))
    expect(extra.map((event) => event.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 2))
    await expect(repositories.startAgentTurn(run.id, run.generation, agent.id, 1)).rejects.toThrow()
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
    const decision = await repositories.appendTaskRunEvent(run.id, run.generation, 'speaker_decided', { agentId: agent.id })
    const turn = await repositories.startAgentTurn(run.id, run.generation, agent.id, decision.seq)
    await expect(repositories.completeAgentTurn(turn.id, '   ')).rejects.toThrow()
    expect(await repositories.listAgentTurns(run.id)).toMatchObject([{ status: 'running' }])
    const completed = await repositories.completeAgentTurn(turn.id, 'Agent private reply')
    expect(completed.message).toMatchObject({ agentId: agent.id, origin: 'agent', status: 'completed', taskRunSeq: 4 })
    expect(completed.turn).toMatchObject({ status: 'completed', messageId: completed.message.id })
    expect((await repositories.listTaskRunEvents(run.id)).map((event) => [event.seq, event.eventType, event.messageId])).toEqual([
      [1, 'ceo_message', expect.any(String)], [2, 'speaker_decided', null], [3, 'turn_started', null], [4, 'turn_completed', completed.message.id],
    ])
    expect(JSON.stringify(await repositories.listTaskRunEvents(run.id))).not.toMatch(/CEO secret|Agent private reply/)
    await expect(repositories.completeAgentTurn(turn.id, 'late reply')).rejects.toThrow()
    const advanced = await repositories.advanceTaskRunGeneration(run.id)
    await expect(repositories.startAgentTurn(run.id, advanced.generation, agent.id, decision.seq)).rejects.toThrow()
    const wrongSpeaker = await repositories.appendTaskRunEvent(run.id, advanced.generation, 'speaker_decided')
    await expect(repositories.startAgentTurn(run.id, advanced.generation, agent.id, wrongSpeaker.seq)).rejects.toThrow()
    const currentDecision = await repositories.appendTaskRunEvent(run.id, advanced.generation, 'speaker_decided', { agentId: agent.id })
    await expect(repositories.startAgentTurn(run.id, advanced.generation, agent.id, currentDecision.seq)).resolves.toMatchObject({ ordinal: 2 })
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

it('orders new messages by run sequence despite tied timestamps and reversed ids', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-team-v03-order-'))
  const filePath = join(directory, 'db.sqlite')
  const sqlite = new Database(filePath)
  try {
    migrate(sqlite)
    sqlite.exec(`
      INSERT INTO projects VALUES ('p','p',NULL,'C:/work','same','same');
      INSERT INTO channels (id,project_id,name,icon,created_at,updated_at) VALUES ('c','p','c',NULL,'same','same');
      INSERT INTO task_runs (id,channel_id,model_config_id,status,generation,created_at) VALUES ('r','c','m','completed',0,'same');
      INSERT INTO messages (id,channel_id,task_run_id,agent_id,origin,task_run_seq,role,author_name,content,status,created_at)
        VALUES ('z','c','r',NULL,'ceo',1,'ceo','CEO','first','sent','same');
      INSERT INTO messages (id,channel_id,task_run_id,agent_id,origin,task_run_seq,role,author_name,content,status,created_at)
        VALUES ('a','c','r',NULL,'ceo',2,'ceo','CEO','second','sent','same');
      INSERT INTO messages (id,channel_id,task_run_id,agent_id,origin,task_run_seq,role,author_name,content,status,created_at)
        VALUES ('legacy-z','c',NULL,NULL,'legacy',NULL,'agent','AI','old-z','completed','before');
      INSERT INTO messages (id,channel_id,task_run_id,agent_id,origin,task_run_seq,role,author_name,content,status,created_at)
        VALUES ('legacy-a','c',NULL,NULL,'legacy',NULL,'agent','AI','old-a','completed','before');
    `)
  } finally { sqlite.close() }
  const db = createDatabase({ filePath })
  try {
    expect((await createRepositories(db).listMessages('c')).map((message) => message.content))
      .toEqual(['old-a', 'old-z', 'first', 'second'])
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
