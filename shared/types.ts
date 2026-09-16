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
  baseUrl: string
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

export interface StreamEvent {
  taskRunId: string
  type: 'delta' | 'complete' | 'error'
  content?: string
  error?: string
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
  tasks: {
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
