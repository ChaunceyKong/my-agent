import type Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { randomUUID } from 'node:crypto'
import type { AgentTurnStatus, ApprovalRequestStatus, ChannelSpeakerMode, MessageOrigin, MessageRole, MessageStatus, MentionSource, MentionStatus, ModelProviderPreset, OverwritePublicationState, TaskRunEventType, TaskRunStatus, ToolExecutionStatus, ToolName, ToolPermissions, ToolRiskLevel } from '../../shared/types'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  icon: text('icon'),
  workspacePath: text('workspace_path').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  speakerMode: text('speaker_mode').$type<ChannelSpeakerMode>().notNull().default('automatic'),
  maxTurns: integer('max_turns').notNull().default(30),
  schedulerModelConfigId: text('scheduler_model_config_id').references(() => modelConfigs.id, { onDelete: 'restrict' }),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const taskRuns = sqliteTable('task_runs', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  modelConfigId: text('model_config_id').notNull(),
  status: text('status').$type<TaskRunStatus>().notNull(),
  generation: integer('generation').notNull().default(0),
  currentTurnId: text('current_turn_id'),
  turnCount: integer('turn_count').notNull().default(0),
  pauseReason: text('pause_reason'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  taskRunId: text('task_run_id').references(() => taskRuns.id, { onDelete: 'set null' }),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  origin: text('origin').$type<MessageOrigin>().notNull().default('legacy'),
  taskRunSeq: integer('task_run_seq'),
  role: text('role').$type<MessageRole>().notNull(),
  authorName: text('author_name').notNull(),
  content: text('content').notNull(),
  status: text('status').$type<MessageStatus>().notNull(),
  createdAt: text('created_at').notNull(),
})

export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  taskRunId: text('task_run_id').references(() => taskRuns.id, { onDelete: 'set null' }),
  eventType: text('event_type').notNull(),
  metadataJson: text('metadata_json').notNull(),
  createdAt: text('created_at').notNull(),
})

export const taskRunEvents = sqliteTable('task_run_events', {
  id: text('id').primaryKey(), taskRunId: text('task_run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(), generation: integer('generation').notNull(),
  eventType: text('event_type').$type<TaskRunEventType>().notNull(),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
  toolExecutionId: text('tool_execution_id').references(() => toolExecutions.id, { onDelete: 'set null' }),
  metadataJson: text('metadata_json').notNull(), displayReason: text('display_reason'), createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('task_run_events_run_seq_idx').on(table.taskRunId, table.seq)])

export const agentTurns = sqliteTable('agent_turns', {
  id: text('id').primaryKey(), taskRunId: text('task_run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  generation: integer('generation').notNull(), status: text('status').$type<AgentTurnStatus>().notNull(),
  triggerEventSeq: integer('trigger_event_seq').notNull(), messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
  startedAt: text('started_at'), finishedAt: text('finished_at'),
}, (table) => [uniqueIndex('agent_turns_run_ordinal_idx').on(table.taskRunId, table.ordinal), uniqueIndex('agent_turns_active_idx').on(table.taskRunId).where(sql`${table.status} IN ('queued','running','waiting_approval')`)])

export const mentionQueue = sqliteTable('mention_queue', {
  taskRunId: text('task_run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(), agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  sourceMessageId: text('source_message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  source: text('source').$type<MentionSource>().notNull(), status: text('status').$type<MentionStatus>().notNull(),
}, (table) => [primaryKey({ columns: [table.taskRunId, table.position] })])

export const sessionSummaries = sqliteTable('session_summaries', {
  id: text('id').primaryKey(), channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  taskRunId: text('task_run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  coveredThroughSeq: integer('covered_through_seq').notNull(), content: text('content').notNull(),
  modelConfigId: text('model_config_id').notNull().references(() => modelConfigs.id, { onDelete: 'restrict' }),
  createdAt: text('created_at').notNull(),
})

export const modelConfigs = sqliteTable('model_configs', {
  id: text('id').primaryKey(),
  providerPreset: text('provider_preset').$type<ModelProviderPreset>().notNull(),
  baseUrl: text('base_url').notNull(),
  modelName: text('model_name').notNull(),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const cloudConsents = sqliteTable('cloud_consents', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  modelConfigId: text('model_config_id').notNull().references(() => modelConfigs.id, { onDelete: 'cascade' }),
  consentedAt: text('consented_at').notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.modelConfigId] })])
export const toolResultConsents = sqliteTable('tool_result_consents', { projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }), modelConfigId: text('model_config_id').notNull().references(() => modelConfigs.id, { onDelete: 'cascade' }), scopeVersion: integer('scope_version').notNull(), consentedAt: text('consented_at').notNull() }, (table) => [primaryKey({ columns: [table.projectId, table.modelConfigId, table.scopeVersion] })])

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  title: text('title').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  modelConfigId: text('model_config_id').notNull().references(() => modelConfigs.id, { onDelete: 'restrict' }),
  defaultToolPermissions: text('default_tool_permissions', { mode: 'json' }).$type<ToolPermissions>().notNull(),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const channelAgents = sqliteTable('channel_agents', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(false),
  modelConfigOverrideId: text('model_config_override_id').references(() => modelConfigs.id, { onDelete: 'restrict' }),
  toolPermissionsOverride: text('tool_permissions_override', { mode: 'json' }).$type<ToolPermissions>(),
  revision: text('revision').notNull().default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.channelId, table.agentId] }),
])

export const toolExecutions = sqliteTable('tool_executions', {
  id: text('id').primaryKey(),
  taskRunId: text('task_run_id').notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  generation: integer('generation').notNull(),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'restrict' }),
  toolName: text('tool_name').$type<ToolName>().notNull(),
  inputJson: text('input_json').notNull(),
  riskLevel: text('risk_level').$type<ToolRiskLevel>().notNull(),
  requestHash: text('request_hash').notNull(),
  policySnapshotJson: text('policy_snapshot_json').notNull(),
  overwriteTargetIdentityJson: text('overwrite_target_identity_json'),
  status: text('status').$type<ToolExecutionStatus>().notNull(),
  resultSummary: text('result_summary'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const approvalRequests = sqliteTable('approval_requests', {
  id: text('id').primaryKey(),
  toolExecutionId: text('tool_execution_id').notNull().references(() => toolExecutions.id, { onDelete: 'cascade' }),
  requestHash: text('request_hash').notNull(),
  generation: integer('generation').notNull(),
  policySnapshotJson: text('policy_snapshot_json').notNull(),
  status: text('status').$type<ApprovalRequestStatus>().notNull(),
  expiresAt: text('expires_at').notNull(),
  decidedAt: text('decided_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('approval_requests_execution_idx').on(table.toolExecutionId)])

export const overwritePublications = sqliteTable('overwrite_publications', {
  executionId: text('execution_id').primaryKey().references(() => toolExecutions.id, { onDelete: 'cascade' }),
  temporaryRelativePath: text('temporary_relative_path').notNull(),
  backupRelativePath: text('backup_relative_path').notNull(),
  temporaryIdentityJson: text('temporary_identity_json'),
  state: text('state').$type<OverwritePublicationState>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const registeredExecutables = sqliteTable('registered_executables', {
  id: text('id').primaryKey(),
  absolutePath: text('absolute_path').notNull(),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(false),
  argumentPolicyJson: text('argument_policy_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const schema = { agentTurns, agents, approvalRequests, auditEvents, channelAgents, channels, cloudConsents, toolResultConsents, mentionQueue, messages, modelConfigs, overwritePublications, projects, registeredExecutables, sessionSummaries, taskRunEvents, taskRuns, toolExecutions }

export function migrate(sqlite: Database.Database): void {
  sqlite.pragma('foreign_keys = ON')
  const version = sqlite.pragma('user_version', { simple: true }) as number

  if (version < 1) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        icon TEXT,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        icon TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS channels_project_id_idx ON channels(project_id);
    `)
    sqlite.pragma('user_version = 1')
  }

  if (version < 2) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        model_config_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelled', 'failed', 'completed', 'paused')),
        started_at TEXT,
        finished_at TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('ceo', 'agent')),
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('sent', 'streaming', 'completed', 'failed')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_channel_id_created_at_idx ON messages(channel_id, created_at);
      CREATE INDEX IF NOT EXISTS task_runs_channel_id_status_idx ON task_runs(channel_id, status);
      CREATE INDEX IF NOT EXISTS audit_events_channel_id_created_at_idx ON audit_events(channel_id, created_at);
    `)
    sqlite.pragma('user_version = 2')
  }

  if (version < 3) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS model_configs (
        id TEXT PRIMARY KEY NOT NULL,
        provider_preset TEXT NOT NULL CHECK (provider_preset IN ('openai', 'deepseek')),
        base_url TEXT NOT NULL,
        model_name TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cloud_consents (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE,
        consented_at TEXT NOT NULL,
        PRIMARY KEY (project_id, model_config_id)
      );
    `)
    sqlite.pragma('user_version = 3')
  }

  if (version < 4) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          avatar TEXT,
          title TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT,
          default_tool_permissions TEXT NOT NULL,
          is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS channel_agents (
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
          is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
          model_config_override_id TEXT REFERENCES model_configs(id) ON DELETE RESTRICT,
          tool_permissions_override TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (channel_id, agent_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS channel_agents_one_enabled_idx ON channel_agents(channel_id) WHERE is_enabled = 1;
      `)
      sqlite.pragma('user_version = 4')
    })()
  }

  if (version < 5) {
    sqlite.transaction(() => {
      sqlite.exec(`
        ALTER TABLE task_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE tool_executions (
          id TEXT PRIMARY KEY NOT NULL,
          task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL,
          message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
          tool_name TEXT NOT NULL,
          input_json TEXT NOT NULL,
          risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
          request_hash TEXT NOT NULL,
          policy_snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('executing', 'waiting_approval', 'completed', 'failed', 'cancelled')),
          result_summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX tool_executions_task_run_idx ON tool_executions(task_run_id);
      `)
      sqlite.pragma('user_version = 5')
    })()
  }

  if (version < 6) {
    sqlite.transaction(() => {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY NOT NULL,
          tool_execution_id TEXT NOT NULL UNIQUE REFERENCES tool_executions(id) ON DELETE CASCADE,
          request_hash TEXT NOT NULL,
          generation INTEGER NOT NULL,
          policy_snapshot_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'executing', 'rejected', 'expired', 'cancelled')),
          expires_at TEXT NOT NULL,
          decided_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registered_executables (
          id TEXT PRIMARY KEY NOT NULL,
          absolute_path TEXT NOT NULL,
          is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
          argument_policy_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      sqlite.pragma('user_version = 6')
    })()
  }
  if (version < 7) { sqlite.exec(`CREATE TABLE IF NOT EXISTS tool_result_consents (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE CASCADE, scope_version INTEGER NOT NULL, consented_at TEXT NOT NULL, PRIMARY KEY (project_id, model_config_id, scope_version));`); sqlite.pragma('user_version = 7') }
  if (version < 8) { sqlite.exec('ALTER TABLE tool_executions ADD COLUMN overwrite_target_identity_json TEXT'); sqlite.pragma('user_version = 8') }
  if (version < 9) { sqlite.exec(`CREATE TABLE IF NOT EXISTS overwrite_publications (
    execution_id TEXT PRIMARY KEY NOT NULL REFERENCES tool_executions(id) ON DELETE CASCADE,
    temporary_relative_path TEXT NOT NULL,
    backup_relative_path TEXT NOT NULL,
    temporary_identity_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('preparing', 'staged', 'publishing', 'effect_claimed', 'published', 'cleanup_pending', 'completed', 'needs_recovery', 'recovered')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`); sqlite.pragma('user_version = 9') }
  if (version < 10) { sqlite.exec(`ALTER TABLE overwrite_publications RENAME TO overwrite_publications_old;
    CREATE TABLE overwrite_publications (execution_id TEXT PRIMARY KEY NOT NULL REFERENCES tool_executions(id) ON DELETE CASCADE, temporary_relative_path TEXT NOT NULL, backup_relative_path TEXT NOT NULL, temporary_identity_json TEXT, state TEXT NOT NULL CHECK (state IN ('preparing','staged','publishing','effect_claimed','published','cleanup_pending','completed','needs_recovery','recovered')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO overwrite_publications SELECT * FROM overwrite_publications_old; DROP TABLE overwrite_publications_old;`); sqlite.pragma('user_version = 10') }
  if (version < 11) {
    sqlite.pragma('foreign_keys = OFF')
    try {
      sqlite.transaction(() => {
        sqlite.exec(`
          ALTER TABLE channels ADD COLUMN speaker_mode TEXT NOT NULL DEFAULT 'automatic' CHECK (speaker_mode IN ('automatic','manual'));
          ALTER TABLE channels ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 30 CHECK (max_turns BETWEEN 1 AND 100);
          ALTER TABLE channels ADD COLUMN scheduler_model_config_id TEXT REFERENCES model_configs(id) ON DELETE RESTRICT;
          CREATE TABLE task_runs_new (
            id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            model_config_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('queued','running','cancelling','cancelled','failed','completed','paused')),
            generation INTEGER NOT NULL DEFAULT 0, current_turn_id TEXT, turn_count INTEGER NOT NULL DEFAULT 0,
            pause_reason TEXT, started_at TEXT, finished_at TEXT, error_message TEXT, created_at TEXT NOT NULL
          );
          INSERT INTO task_runs_new (id,channel_id,model_config_id,status,generation,started_at,finished_at,error_message,created_at)
            SELECT id,channel_id,model_config_id,status,generation,started_at,finished_at,error_message,created_at FROM task_runs;
          DROP TABLE task_runs;
          ALTER TABLE task_runs_new RENAME TO task_runs;
          CREATE INDEX task_runs_channel_id_status_idx ON task_runs(channel_id,status);
          ALTER TABLE messages ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL;
          ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK (origin IN ('ceo','agent','legacy'));
          ALTER TABLE messages ADD COLUMN task_run_seq INTEGER;
          CREATE TABLE task_run_events (
            id TEXT PRIMARY KEY NOT NULL, task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL, generation INTEGER NOT NULL, event_type TEXT NOT NULL,
            agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
            message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            tool_execution_id TEXT REFERENCES tool_executions(id) ON DELETE SET NULL,
            metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 2048), created_at TEXT NOT NULL,
            UNIQUE(task_run_id,seq)
          );
          CREATE TABLE agent_turns (
            id TEXT PRIMARY KEY NOT NULL, task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
            generation INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled')),
            trigger_event_seq INTEGER NOT NULL, message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            started_at TEXT, finished_at TEXT, UNIQUE(task_run_id,ordinal)
          );
          CREATE UNIQUE INDEX agent_turns_active_idx ON agent_turns(task_run_id) WHERE status IN ('queued','running','waiting_approval');
          CREATE TABLE mention_queue (
            task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE, position INTEGER NOT NULL,
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
            source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            source TEXT NOT NULL CHECK (source IN ('ceo','agent')),
            status TEXT NOT NULL CHECK (status IN ('pending','consumed','cancelled')),
            PRIMARY KEY (task_run_id,position)
          );
          CREATE TABLE session_summaries (
            id TEXT PRIMARY KEY NOT NULL, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
            task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
            covered_through_seq INTEGER NOT NULL, content TEXT NOT NULL,
            model_config_id TEXT NOT NULL REFERENCES model_configs(id) ON DELETE RESTRICT, created_at TEXT NOT NULL
          );
        `)
        const duplicates = sqlite.prepare(`SELECT id,channel_id,generation FROM task_runs WHERE status='running' AND channel_id IN (SELECT channel_id FROM task_runs WHERE status='running' GROUP BY channel_id HAVING count(*) > 1)`).all() as Array<{ id: string; channel_id: string; generation: number }>
        const pause = sqlite.prepare(`UPDATE task_runs SET status='paused',generation=generation+1,pause_reason='migration_duplicate_running' WHERE id=?`)
        const audit = sqlite.prepare(`INSERT INTO audit_events (id,channel_id,task_run_id,event_type,metadata_json,created_at) VALUES (?,?,?,?,?,?)`)
        const now = new Date().toISOString()
        for (const run of duplicates) {
          pause.run(run.id)
          audit.run(randomUUID(), run.channel_id, run.id, 'task_run_paused', JSON.stringify({ reason: 'migration_duplicate_running', generation: run.generation + 1 }), now)
        }
        sqlite.exec(`CREATE UNIQUE INDEX task_runs_one_active_idx ON task_runs(channel_id) WHERE status IN ('running','cancelling');`)
        const violations = sqlite.pragma('foreign_key_check') as Array<unknown>
        if (violations.length) throw new Error('v0.3 migration foreign key check failed')
        sqlite.pragma('user_version = 11')
      })()
    } finally {
      sqlite.pragma('foreign_keys = ON')
    }
  }

  if (Number(sqlite.pragma('user_version', { simple: true })) < 12) {
    sqlite.transaction(() => {
      sqlite.exec("ALTER TABLE channel_agents ADD COLUMN revision TEXT NOT NULL DEFAULT ''")
      sqlite.exec('DROP INDEX IF EXISTS channel_agents_one_enabled_idx')
      sqlite.pragma('user_version = 12')
    })()
  }
  if (Number(sqlite.pragma('user_version', { simple: true })) < 13) {
    sqlite.transaction(() => {
      sqlite.exec('ALTER TABLE task_run_events ADD COLUMN display_reason TEXT')
      sqlite.pragma('user_version = 13')
    })()
  }
}
