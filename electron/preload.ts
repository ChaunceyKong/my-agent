import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type {
  AgentTeamApi,
  CreateChannelInput,
  CreateProjectRequest,
  SaveModelConfigInput,
  SendMessageInput,
  StreamEvent,
} from '../shared/types'

const api: AgentTeamApi = {
  agents: {
    list: () => ipcRenderer.invoke(IpcChannel.AgentList),
    get: (id) => ipcRenderer.invoke(IpcChannel.AgentGet, id),
    create: (input) => ipcRenderer.invoke(IpcChannel.AgentCreate, input),
    update: (id, input) => ipcRenderer.invoke(IpcChannel.AgentUpdate, id, input),
    remove: (id) => ipcRenderer.invoke(IpcChannel.AgentRemove, id),
  },
  channelAgents: {
    list: (channelId) => ipcRenderer.invoke(IpcChannel.ChannelAgentList, channelId),
    save: (input) => ipcRenderer.invoke(IpcChannel.ChannelAgentSave, input),
    remove: (channelId, agentId) => ipcRenderer.invoke(IpcChannel.ChannelAgentRemove, channelId, agentId),
  },
  approvals: {
    approve: (id, requestHash) => ipcRenderer.invoke(IpcChannel.ApprovalApprove, id, requestHash),
    reject: (id, requestHash) => ipcRenderer.invoke(IpcChannel.ApprovalReject, id, requestHash),
    expire: (id) => ipcRenderer.invoke(IpcChannel.ApprovalExpire, id),
    runApproved: (id) => ipcRenderer.invoke(IpcChannel.ApprovalRunApproved, id),
    list: (taskRunId) => ipcRenderer.invoke(IpcChannel.ApprovalList, taskRunId),
  },
  tools: { list: (taskRunId) => ipcRenderer.invoke(IpcChannel.ToolExecutionList, taskRunId) },
  workspace: { list: (channelId, path) => ipcRenderer.invoke(IpcChannel.WorkspaceList, channelId, path) },
  executables: {
    list: () => ipcRenderer.invoke(IpcChannel.ExecutableList),
    save: (input) => ipcRenderer.invoke(IpcChannel.ExecutableSave, input),
  },
  projects: {
    list: () => ipcRenderer.invoke(IpcChannel.ProjectList),
    pickWorkspace: () => ipcRenderer.invoke(IpcChannel.ProjectPickWorkspace),
    create: (input: CreateProjectRequest) => ipcRenderer.invoke(IpcChannel.ProjectCreate, input),
  },
  channels: {
    list: (projectId: string) => ipcRenderer.invoke(IpcChannel.ChannelList, projectId),
    create: (input: CreateChannelInput) => ipcRenderer.invoke(IpcChannel.ChannelCreate, input),
    setScheduler: (channelId, modelConfigId) => ipcRenderer.invoke(IpcChannel.ChannelSetScheduler, channelId, modelConfigId),
    configure: (input) => ipcRenderer.invoke(IpcChannel.ChannelConfigure, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.ChannelRemove, input),
  },
  models: {
    list: () => ipcRenderer.invoke(IpcChannel.ModelList),
    save: (input: SaveModelConfigInput) => ipcRenderer.invoke(IpcChannel.ModelSave, input),
    remove: (id) => ipcRenderer.invoke(IpcChannel.ModelRemove, id),
    test: (id) => ipcRenderer.invoke(IpcChannel.ModelTest, id),
    discover: (baseUrl) => ipcRenderer.invoke(IpcChannel.ModelDiscover, baseUrl),
    getDefaultScheduler: () => ipcRenderer.invoke(IpcChannel.ModelDefaultGet),
    setDefaultScheduler: (id) => ipcRenderer.invoke(IpcChannel.ModelDefaultSet, id),
  },
  tasks: {
    list: (channelId: string) => ipcRenderer.invoke(IpcChannel.TaskRunList, channelId),
    snapshot: (channelId) => ipcRenderer.invoke(IpcChannel.TaskRunSnapshot, channelId),
    send: (input: SendMessageInput) => ipcRenderer.invoke(IpcChannel.MessageSend, input),
    cancel: (taskRunId: string) => ipcRenderer.invoke(IpcChannel.TaskRunCancel, taskRunId),
    continue: (taskRunId) => ipcRenderer.invoke(IpcChannel.TaskRunContinue, taskRunId),
    assign: (taskRunId, agentId) => ipcRenderer.invoke(IpcChannel.TaskRunAssign, taskRunId, agentId),
    terminate: (taskRunId) => ipcRenderer.invoke(IpcChannel.TaskRunTerminate, taskRunId),
    interrupt: (taskRunId, input) => ipcRenderer.invoke(IpcChannel.TaskRunInterrupt, taskRunId, input),
    acknowledgeProcessRecovery: (taskRunId, toolExecutionId, confirmation) => ipcRenderer.invoke(IpcChannel.TaskRunAcknowledgeProcessRecovery, taskRunId, toolExecutionId, confirmation),
  },
  messages: {
    list: (channelId: string) => ipcRenderer.invoke(IpcChannel.MessageList, channelId),
  },
  consent: {
    has: (projectId: string, modelConfigId: string) => ipcRenderer.invoke(IpcChannel.CloudConsentHas, projectId, modelConfigId),
    grant: (projectId: string, modelConfigId: string, scope: { allowToolResultUpload: true }) => ipcRenderer.invoke(IpcChannel.CloudConsentGrant, projectId, modelConfigId, scope),
  },
  events: {
    onStream: (listener) => {
      const onStream = (_event: Electron.IpcRendererEvent, event: StreamEvent) => listener(event)
      ipcRenderer.on(IpcChannel.MessageStream, onStream)
      return () => ipcRenderer.removeListener(IpcChannel.MessageStream, onStream)
    },
  },
}

contextBridge.exposeInMainWorld('agentTeam', api)
