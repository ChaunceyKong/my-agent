import { IpcChannel } from '../../shared/ipc-channels'
import type { CreateChannelInput, CreateProjectInput, SendMessageInput } from '../../shared/types'
import type { TaskRunService } from '../core/task-run-service'
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
}

export function registerHandlers({ ipcMain, dialog, repositories, taskRuns }: IpcHandlerDependencies): void {
  ipcMain.handle(IpcChannel.ProjectList, () => repositories.listProjects())
  ipcMain.handle(IpcChannel.ProjectCreate, async (_event, input: CreateProjectInput) => {
    const workspacePath = input.browseForWorkspace
      ? await pickWorkspacePath(dialog)
      : input.workspacePath
    const canonicalWorkspacePath = await validateWorkspaceRoot(workspacePath)
    const { project } = await repositories.createProjectWithInitialChannel({
      ...input,
      workspacePath: canonicalWorkspacePath,
    })
    return project
  })
  ipcMain.handle(IpcChannel.ChannelList, (_event, projectId: string) => repositories.listChannels(projectId))
  ipcMain.handle(IpcChannel.ChannelCreate, (_event, input: CreateChannelInput) => repositories.createChannel(input))
  ipcMain.handle(IpcChannel.MessageSend, (_event, input: SendMessageInput) => {
    if (!taskRuns) throw new Error('TaskRun service is unavailable')
    return taskRuns.startTaskRun(input.channelId, input.modelConfigId, input.content)
      .then((taskRun) => ({ taskRunId: taskRun.id }))
  })
  ipcMain.handle(IpcChannel.TaskRunCancel, async (_event, taskRunId: string) => {
    if (!taskRuns) throw new Error('TaskRun service is unavailable')
    await taskRuns.cancelTaskRun(taskRunId)
  })
}

async function pickWorkspacePath(dialog: DirectoryPicker): Promise<string> {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) throw new Error('未选择工作区路径')
  return result.filePaths[0]
}
