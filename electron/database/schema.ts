import type Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { MessageRole, MessageStatus, ModelProviderPreset, TaskRunStatus, ToolPermissions } from '../../shared/types'

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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const taskRuns = sqliteTable('task_runs', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  modelConfigId: text('model_config_id').notNull(),
  status: text('status').$type<TaskRunStatus>().notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  taskRunId: text('task_run_id').references(() => taskRuns.id, { onDelete: 'set null' }),
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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.channelId, table.agentId] }),
  uniqueIndex('channel_agents_one_enabled_idx').on(table.channelId).where(sql`${table.isEnabled} = 1`),
])

export const schema = { agents, auditEvents, channelAgents, channels, cloudConsents, messages, modelConfigs, projects, taskRuns }

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
}
