export interface Project {
  id: string
  name: string
  icon: string | null
  workspacePath: string
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  name: string
  icon?: string
  workspacePath: string
  firstChannelName?: string
}

export interface Channel {
  id: string
  projectId: string
  name: string
  icon: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateChannelInput {
  projectId: string
  name: string
  icon?: string
}

export type ToolName = 'list_dir' | 'read_file' | 'search_files' | 'write_file' | 'replace_file_content' | 'run_process'
// Missing permissions deny access. Channel overrides are intersected with Agent defaults.
export type ToolPermissions = Partial<Record<ToolName, boolean>>

export type FileToolErrorCode = 'INVALID_PATH' | 'SENSITIVE_PATH' | 'LINK_NOT_ALLOWED' | 'PATH_UNAVAILABLE'
  | 'NOT_DIRECTORY' | 'NOT_FILE' | 'FILE_TOO_LARGE' | 'INVALID_TEXT' | 'INVALID_QUERY' | 'FILE_CHANGED'

export interface FileToolLimits {
  maxPathChars: number
  maxFileBytes: number
  maxContentChars: number
  maxDirectoryEntries: number
  maxSearchMatches: number
  maxExcerptChars: number
  maxQueryChars: number
  maxVisitedEntries: number
  maxSearchBytes: number
  maxDepth: number
  maxResultChars: number
}

export interface FileToolResult {
  path: string
  summary: string
  truncated: boolean
  limits: Readonly<FileToolLimits>
}

export interface DirectoryEntry {
  path: string
  name: string
  type: 'file' | 'directory'
}

export interface ListDirectoryResult extends FileToolResult {
  entries: DirectoryEntry[]
}

export interface ReadTextFileResult extends FileToolResult {
  content: string
  bytes: number
}

export interface SearchTextFilesResult extends FileToolResult {
  matches: { path: string; line: number; excerpt: string }[]
  visitedEntries: number
  // Conservative byte charge: failed decodes retain the reserved maximum file size.
  searchedBytes: number
  skippedFiles: number
}

export interface AgentEditorInput {
  name: string
  avatar: string | null
  title: string
  systemPrompt: string
  modelConfigId: string
  defaultToolPermissions: ToolPermissions
}

export interface Agent extends AgentEditorInput {
  id: string
  isBuiltin: boolean
  createdAt: string
  updatedAt: string
}

export type AgentSummary = Omit<Agent, 'systemPrompt'>

export interface SaveChannelAgentInput {
  channelId: string
  agentId: string
  isEnabled: boolean
  modelConfigOverrideId: string | null
  toolPermissionsOverride: ToolPermissions | null
}

export interface ChannelAgent extends SaveChannelAgentInput {
  createdAt: string
  updatedAt: string
}

export type ModelProviderPreset = 'openai' | 'deepseek'

export interface SaveModelConfigInput {
  providerPreset: ModelProviderPreset
  baseUrl?: string
  modelName: string
  apiKey: string
}

export interface ModelConfigSummary {
  id: string
  providerPreset: ModelProviderPreset
  baseUrl: string
  modelName: string
  hasApiKey: boolean
}

export interface SendMessageInput {
  channelId: string
  content: string
  modelConfigId: string
}

export type MessageRole = 'ceo' | 'agent'
export type MessageStatus = 'sent' | 'streaming' | 'completed' | 'failed'

export interface Message {
  id: string
  channelId: string
  taskRunId: string | null
  role: MessageRole
  authorName: string
  content: string
  status: MessageStatus
  createdAt: string
}

export type TaskRunStatus = 'queued' | 'running' | 'cancelled' | 'failed' | 'completed' | 'paused'

export interface TaskRun {
  id: string
  channelId: string
  modelConfigId: string
  status: TaskRunStatus
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  createdAt: string
}

export interface AuditEvent {
  id: string
  channelId: string
  taskRunId: string | null
  eventType: string
  metadataJson: string
  createdAt: string
}

export interface StreamEvent {
  taskRunId: string
  type: 'delta' | 'complete' | 'error'
  content?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamChatInput {
  projectId: string
  modelConfigId: string
  taskRunId: string
  messages: ChatMessage[]
}

export interface AgentTeamApi {
  agents: {
    list(): Promise<AgentSummary[]>
    get(id: string): Promise<Agent>
    create(input: AgentEditorInput): Promise<AgentSummary>
    update(id: string, input: AgentEditorInput): Promise<AgentSummary>
    remove(id: string): Promise<void>
  }
  channelAgents: {
    list(channelId: string): Promise<ChannelAgent[]>
    save(input: SaveChannelAgentInput): Promise<ChannelAgent>
    remove(channelId: string, agentId: string): Promise<void>
  }
  projects: {
    list(): Promise<Project[]>
    pickWorkspace(): Promise<string | undefined>
    create(input: CreateProjectInput): Promise<Project>
  }
  channels: {
    list(projectId: string): Promise<Channel[]>
    create(input: CreateChannelInput): Promise<Channel>
  }
  models: {
    list(): Promise<ModelConfigSummary[]>
    save(input: SaveModelConfigInput): Promise<ModelConfigSummary>
  }
  messages: {
    list(channelId: string): Promise<Message[]>
  }
  consent: {
    has(projectId: string, modelConfigId: string): Promise<boolean>
    grant(projectId: string, modelConfigId: string): Promise<void>
  }
  tasks: {
    list(channelId: string): Promise<TaskRun[]>
    send(input: SendMessageInput): Promise<{ taskRunId: string }>
    cancel(taskRunId: string): Promise<void>
  }
  events: {
    onStream(listener: (event: StreamEvent) => void): () => void
  }
}

declare global {
  interface Window {
    agentTeam: AgentTeamApi
  }
}
