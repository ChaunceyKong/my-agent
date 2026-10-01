export interface Project {
  id: string
  name: string
  icon: string | null
  workspacePath: string
  createdAt: string
  updatedAt: string
}

/** Safe renderer-facing metadata. Workspace roots stay in Main. */
export type ProjectSummary = Omit<Project, 'workspacePath'>
export interface WorkspaceSelection { id: string; label: string }
export interface CreateProjectRequest {
  name: string
  icon?: string
  workspaceId: string
  firstChannelName?: string
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
  speakerMode: ChannelSpeakerMode
  maxTurns: number
  schedulerModelConfigId: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelSpeakerMode = 'automatic' | 'manual'

export interface CreateChannelInput {
  projectId: string
  name: string
  icon?: string
}

export type ToolName = 'list_dir' | 'read_file' | 'search_files' | 'write_file' | 'replace_file_content' | 'run_process'
// Missing permissions deny access. Channel overrides are intersected with Agent defaults.
export type ToolPermissions = Partial<Record<ToolName, boolean>>

export type ToolRequest =
  | { toolName: 'list_dir'; input: { path: string } }
  | { toolName: 'read_file'; input: { path: string } }
  | { toolName: 'search_files'; input: { path: string; query: string } }
  | { toolName: 'write_file'; input: { path: string; content: string } }
  | { toolName: 'replace_file_content'; input: { path: string; content: string } }
  | { toolName: 'run_process'; input: { executableId: string; args: string[] } }

export type ToolExecutionStatus = 'executing' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
export type ToolRiskLevel = 'low' | 'medium' | 'high'

export interface ToolExecution {
  id: string
  taskRunId: string
  generation: number
  messageId: string | null
  agentId: string
  toolName: ToolName
  inputJson: string
  riskLevel: ToolRiskLevel
  requestHash: string
  policySnapshotJson: string
  /** Bound when an existing file is submitted for explicit replacement approval. */
  overwriteTargetIdentityJson: string | null
  status: ToolExecutionStatus
  resultSummary: string | null
  createdAt: string
  updatedAt: string
}

/** Stable file attributes captured before an overwrite approval is created. */
export interface OverwriteTargetIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export type OverwritePublicationState = 'preparing' | 'staged' | 'publishing' | 'effect_claimed' | 'published' | 'cleanup_pending' | 'completed' | 'needs_recovery' | 'recovered'

/** Main-process recovery journal for an explicitly approved file replacement. */
export interface OverwritePublication {
  executionId: string
  temporaryRelativePath: string
  backupRelativePath: string
  temporaryIdentityJson: string | null
  state: OverwritePublicationState
  createdAt: string
  updatedAt: string
}

export interface ToolPolicySnapshot {
  version: 1
  workspacePath: string
  agentId: string
  turnId: string | null
  memberRevision: string
  defaultToolPermissions: ToolPermissions
  toolPermissionsOverride: ToolPermissions | null
  /** Main-generated immutable identity of the process registration, when relevant. */
  registeredExecutable: { canonicalPath: string; isEnabled: boolean; argumentPolicyHash: string } | null
}

export type ApprovalRequestStatus = 'pending' | 'approved' | 'executing' | 'rejected' | 'expired' | 'cancelled'

export interface ApprovalRequest {
  id: string
  toolExecutionId: string
  requestHash: string
  generation: number
  policySnapshotJson: string
  status: ApprovalRequestStatus
  expiresAt: string
  decidedAt: string | null
  createdAt: string
}

export interface RegisteredExecutable {
  id: string
  absolutePath: string
  isEnabled: boolean
  argumentPolicyJson: string
  createdAt: string
  updatedAt: string
}

export interface RegisteredExecutableInput {
  id: string
  absolutePath: string
  isEnabled: boolean
  allowedArgs: string[]
}

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
  revision: string
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
  mentions?: CeoMentionToken[]
}

export interface CeoMentionToken { agentId: string; start: number; end: number; text: string }

export type MessageRole = 'ceo' | 'agent'
export type MessageStatus = 'sent' | 'streaming' | 'completed' | 'failed'

export interface Message {
  id: string
  channelId: string
  taskRunId: string | null
  agentId: string | null
  origin: MessageOrigin
  taskRunSeq: number | null
  role: MessageRole
  authorName: string
  content: string
  status: MessageStatus
  createdAt: string
}

export type MessageOrigin = 'ceo' | 'agent' | 'legacy'

export type TaskRunStatus = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'failed' | 'completed' | 'paused'

export interface TaskRun {
  id: string
  channelId: string
  modelConfigId: string
  status: TaskRunStatus
  generation: number
  currentTurnId: string | null
  turnCount: number
  pauseReason: string | null
  startedAt: string | null
  finishedAt: string | null
  errorMessage: string | null
  createdAt: string
}

export type TaskRunEventType = 'ceo_message' | 'mention_queued' | 'mention_consumed' | 'speaker_decided' | 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_cancelled' | 'tool_waiting' | 'tool_decided' | 'summary_created' | 'generation_advanced' | 'task_paused' | 'task_resumed' | 'task_cancelling' | 'task_cancelled' | 'task_completed' | 'task_failed'
export interface TaskRunEvent {
  id: string; taskRunId: string; seq: number; generation: number; eventType: TaskRunEventType
  agentId: string | null; messageId: string | null; toolExecutionId: string | null
  metadataJson: string; displayReason: string | null; createdAt: string
}
export type AgentTurnStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
export interface AgentTurn {
  id: string; taskRunId: string; ordinal: number; agentId: string; generation: number
  status: AgentTurnStatus; triggerEventSeq: number; messageId: string | null
  startedAt: string | null; finishedAt: string | null
}
export type MentionSource = 'ceo' | 'agent'
export type MentionStatus = 'pending' | 'consumed' | 'cancelled'
export interface MentionQueueItem { taskRunId: string; position: number; agentId: string; sourceMessageId: string; source: MentionSource; status: MentionStatus }
export interface SessionSummary { id: string; channelId: string; taskRunId: string; coveredThroughSeq: number; content: string; modelConfigId: string; createdAt: string }

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
  type: 'delta' | 'tool_call' | 'complete' | 'error'
  content?: string
  toolCall?: NativeToolCall
}

export interface NativeToolCall { id: string; index: number; name: ToolName; arguments: string }
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
} | { role: 'assistant'; content: null; tool_calls: NativeToolCall[] } | { role: 'tool'; tool_call_id: string; content: string }

export interface NativeToolDefinition { type: 'function'; function: { name: ToolName; description: string; parameters: Record<string, unknown> } }

export interface StreamChatInput {
  projectId: string
  modelConfigId: string
  taskRunId: string
  messages: ChatMessage[]
  tools?: NativeToolDefinition[]
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
  approvals: {
    approve(id: string, requestHash: string): Promise<{ id: string; status: ApprovalRequestStatus }>
    reject(id: string, requestHash: string): Promise<{ id: string; status: ApprovalRequestStatus }>
    expire(id: string): Promise<{ id: string; status: ApprovalRequestStatus }>
    runApproved(id: string): Promise<void>
    list(taskRunId: string): Promise<Array<Pick<ApprovalRequest, 'id' | 'toolExecutionId' | 'requestHash' | 'status' | 'expiresAt'>>>
  }
  tools: { list(taskRunId: string): Promise<Array<Pick<ToolExecution, 'id' | 'taskRunId' | 'toolName' | 'riskLevel' | 'status' | 'resultSummary' | 'createdAt'>>> }
  workspace: { list(channelId: string, path: string): Promise<ListDirectoryResult> }
  executables: {
    list(): Promise<Array<Pick<RegisteredExecutable, 'id' | 'isEnabled'>>>
    save(input: RegisteredExecutableInput): Promise<Pick<RegisteredExecutable, 'id' | 'isEnabled'>>
  }
  projects: {
    list(): Promise<ProjectSummary[]>
    pickWorkspace(): Promise<WorkspaceSelection | undefined>
    create(input: CreateProjectRequest): Promise<ProjectSummary>
  }
  channels: {
    list(projectId: string): Promise<Channel[]>
    create(input: CreateChannelInput): Promise<Channel>
    setScheduler(channelId: string, modelConfigId: string | null): Promise<Channel>
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
    grant(projectId: string, modelConfigId: string, scope: { allowToolResultUpload: true }): Promise<void>
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
