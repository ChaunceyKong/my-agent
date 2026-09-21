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
  browseForWorkspace?: boolean
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
  projects: {
    list(): Promise<Project[]>
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
