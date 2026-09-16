import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc-channels'
import type {
  AgentTeamApi,
  CreateChannelInput,
  CreateProjectInput,
  SaveModelConfigInput,
  SendMessageInput,
  StreamEvent,
} from '../shared/types'

const api: AgentTeamApi = {
  projects: {
    list: () => ipcRenderer.invoke(IpcChannel.ProjectList),
    create: (input: CreateProjectInput) => ipcRenderer.invoke(IpcChannel.ProjectCreate, input),
  },
  channels: {
    list: (projectId: string) => ipcRenderer.invoke(IpcChannel.ChannelList, projectId),
    create: (input: CreateChannelInput) => ipcRenderer.invoke(IpcChannel.ChannelCreate, input),
  },
  models: {
    list: () => ipcRenderer.invoke(IpcChannel.ModelList),
    save: (input: SaveModelConfigInput) => ipcRenderer.invoke(IpcChannel.ModelSave, input),
  },
  tasks: {
    send: (input: SendMessageInput) => ipcRenderer.invoke(IpcChannel.MessageSend, input),
    cancel: (taskRunId: string) => ipcRenderer.invoke(IpcChannel.TaskRunCancel, taskRunId),
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
