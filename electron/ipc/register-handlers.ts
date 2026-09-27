import { IpcChannel } from '../../shared/ipc-channels'
import type { CreateChannelInput, CreateProjectInput, SaveModelConfigInput, SendMessageInput, StreamEvent } from '../../shared/types'
import type { TaskRunService } from '../core/task-run-service'
import type { ModelClient } from '../core/model-client'
import { validateWorkspaceRoot } from '../core/workspace-validator'
import type { Repositories } from '../database/repositories'

interface IpcHandlerRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void
}

interface DirectoryPicker {
  showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>
}

export interface IpcHandlerDependencies {
  ipcMain: IpcHandlerRegistrar
  dialog: DirectoryPicker
  repositories: Repositories
  taskRuns?: TaskRunService
  modelClient?: ModelClient
}

export function registerHandlers({ ipcMain, dialog, repositories, taskRuns, modelClient }: IpcHandlerDependencies): void {
  const startingChannels = new Set<string>()
  ipcMain.handle(IpcChannel.ProjectList, () => repositories.listProjects())
  ipcMain.handle(IpcChannel.ProjectPickWorkspace, () => pickWorkspacePath(dialog))
  ipcMain.handle(IpcChannel.ProjectCreate, async (_event, input: CreateProjectInput) => {
    const canonicalWorkspacePath = await validateWorkspaceRoot(input.workspacePath)
    const { project } = await repositories.createProjectWithInitialChannel({
      ...input,
      workspacePath: canonicalWorkspacePath,
    })
    return project
  })
  ipcMain.handle(IpcChannel.ChannelList, (_event, projectId: string) => repositories.listChannels(projectId))
  ipcMain.handle(IpcChannel.ChannelCreate, (_event, input: CreateChannelInput) => repositories.createChannel(input))
  ipcMain.handle(IpcChannel.ModelList, () => {
    if (!modelClient) throw new Error('Model client is unavailable')
    return modelClient.listModelConfigs()
  })
  ipcMain.handle(IpcChannel.ModelSave, (_event, input: SaveModelConfigInput) => {
    if (!modelClient) throw new Error('Model client is unavailable')
    return modelClient.saveModelConfig(input)
  })
  ipcMain.handle(IpcChannel.MessageList, (_event, channelId: string) => repositories.listMessages(channelId))
  ipcMain.handle(IpcChannel.TaskRunList, (_event, channelId: string) => repositories.listTaskRuns(channelId))
  ipcMain.handle(IpcChannel.CloudConsentHas, (_event, projectId: string, modelConfigId: string) => repositories.hasCloudConsent(projectId, modelConfigId))
  ipcMain.handle(IpcChannel.CloudConsentGrant, async (_event, projectId: string, modelConfigId: string) => {
    const project = (await repositories.listProjects()).find((item) => item.id === projectId)
    if (!project || !await repositories.getModelConfig(modelConfigId)) throw new Error('项目或模型配置不存在')
    await repositories.recordCloudConsent(projectId, modelConfigId)
  })
  ipcMain.handle(IpcChannel.MessageSend, async (event, input: SendMessageInput) => {
    if (!taskRuns || !modelClient) throw new Error('模型服务不可用')
    if (!input || typeof input.content !== 'string' || !input.content.trim()) throw new Error('消息不能为空')
    if (startingChannels.has(input.channelId)) throw new Error('当前群聊已有任务正在运行')
    startingChannels.add(input.channelId)
    try {
      const channel = await repositories.getChannel(input.channelId)
      if (!channel || !await repositories.getModelConfig(input.modelConfigId)) throw new Error('群聊或模型配置不存在')
      if ((await repositories.listTaskRuns(channel.id)).some((run) => run.status === 'running')) throw new Error('当前群聊已有任务正在运行')
      await modelClient.requireCloudConsent(channel.projectId, input.modelConfigId)
      const run = await taskRuns.startTaskRun(channel.id, input.modelConfigId, input.content.trim())
      const sender = (event as { sender: StreamSender }).sender
      void streamReply(run.id, channel.projectId, input.modelConfigId, channel.id, sender, repositories, taskRuns, modelClient)
      return { taskRunId: run.id }
    } finally {
      startingChannels.delete(input.channelId)
    }
  })
  ipcMain.handle(IpcChannel.TaskRunCancel, async (_event, taskRunId: string) => {
    if (!taskRuns) throw new Error('TaskRun service is unavailable')
    await taskRuns.cancelTaskRun(taskRunId)
  })
}

interface StreamSender {
  isDestroyed(): boolean
  send(channel: string, event: StreamEvent): void
}

async function streamReply(
  taskRunId: string, projectId: string, modelConfigId: string, channelId: string,
  sender: StreamSender, repositories: Repositories, taskRuns: TaskRunService, modelClient: ModelClient,
): Promise<void> {
  let reply = ''
  const accept = async (event: StreamEvent): Promise<void> => {
    if (!await taskRuns.canAcceptChunk(taskRunId)) return
    if (event.type === 'delta') reply += event.content ?? ''
    if (event.type === 'complete') await taskRuns.finishTaskRun(taskRunId, reply)
    if (event.type === 'error') {
      const failed = await repositories.transitionTaskRun(taskRunId, 'running', 'failed', { errorMessage: event.content ?? '模型请求失败，请稍后重试' })
      if (!failed) return
    }
    if (!sender.isDestroyed()) sender.send(IpcChannel.MessageStream, event)
  }
  try {
    const history = await repositories.listMessages(channelId)
    await modelClient.streamChat({ projectId, modelConfigId, taskRunId,
      messages: history.map((message) => ({ role: message.role === 'ceo' ? 'user' : 'assistant', content: message.content })),
    }, accept)
  } catch {
    // Never expose credential, storage, or transport exception text through IPC.
    const message = '模型请求失败，请检查配置后重试'
    const failed = await repositories.transitionTaskRun(taskRunId, 'running', 'failed', { errorMessage: message }).catch(() => undefined)
    if (failed && !sender.isDestroyed()) sender.send(IpcChannel.MessageStream, { taskRunId, type: 'error', content: message })
  }
}

async function pickWorkspacePath(dialog: DirectoryPicker): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return undefined
  return result.filePaths[0]
}
