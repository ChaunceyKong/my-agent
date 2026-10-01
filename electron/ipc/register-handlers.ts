import { IpcChannel } from '../../shared/ipc-channels'
import type { AgentEditorInput, CreateChannelInput, CreateProjectInput, RegisteredExecutableInput, SaveChannelAgentInput, SaveModelConfigInput, SendMessageInput, StreamEvent } from '../../shared/types'
import type { createApprovalService } from '../core/approval-service'
import type { createProcessToolService } from '../core/process-tool-service'
import { hasWindowsAliasSegment, isSafeRegisteredExecutable } from '../core/process-tool'
import { createAgentService } from '../core/agent-service'
import type { TaskRunService } from '../core/task-run-service'
import type { ModelClient } from '../core/model-client'
import type { createSingleAgentRunner } from '../core/single-agent-runner'
import type { createSerialOrchestrator } from '../core/serial-orchestrator'
import { validateWorkspaceRoot } from '../core/workspace-validator'
import { listDirectory } from '../core/file-tools'
import type { Repositories } from '../database/repositories'
import { randomUUID } from 'node:crypto'

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
  approvals?: ReturnType<typeof createApprovalService>
  processes?: ReturnType<typeof createProcessToolService>
  runner?: ReturnType<typeof createSingleAgentRunner>
  orchestrator?: ReturnType<typeof createSerialOrchestrator>
}

export function registerHandlers({ ipcMain, dialog, repositories, taskRuns, modelClient, approvals, processes, runner, orchestrator }: IpcHandlerDependencies): void {
  const startingChannels = new Set<string>()
  const workspaceSelections = new Map<string, string>()
  const agents = createAgentService(repositories)
  ipcMain.handle(IpcChannel.AgentList, () => agents.list())
  ipcMain.handle(IpcChannel.AgentGet, (_event, id: string) => agents.get(id))
  ipcMain.handle(IpcChannel.AgentCreate, (_event, input: AgentEditorInput) => agents.create(input))
  ipcMain.handle(IpcChannel.AgentUpdate, (_event, id: string, input: AgentEditorInput) => agents.update(id, input))
  ipcMain.handle(IpcChannel.AgentRemove, (_event, id: string) => agents.remove(id))
  ipcMain.handle(IpcChannel.ChannelAgentList, (_event, channelId: string) => agents.listChannelAgents(channelId))
  ipcMain.handle(IpcChannel.ChannelAgentSave, (_event, input: SaveChannelAgentInput) => agents.saveChannelAgent(input))
  ipcMain.handle(IpcChannel.ChannelAgentRemove, (_event, channelId: string, agentId: string) => agents.removeChannelAgent(channelId, agentId))
  ipcMain.handle(IpcChannel.ApprovalApprove, async (_event, id: unknown, requestHash: unknown) => safeApproval(await requireApprovals(approvals).approve(validId(id), validHash(requestHash))))
  ipcMain.handle(IpcChannel.ApprovalReject, async (_event, id: unknown, requestHash: unknown) => safeApproval(await requireApprovals(approvals).reject(validId(id), validHash(requestHash))))
  ipcMain.handle(IpcChannel.ApprovalExpire, async (_event, id: unknown) => safeApproval(await requireApprovals(approvals).expire(validId(id))))
  ipcMain.handle(IpcChannel.ApprovalRunApproved, async (_event, id: unknown) => { await requireProcesses(processes).runApproved(validId(id)) })
  ipcMain.handle(IpcChannel.ExecutableList, async () => (await repositories.listRegisteredExecutables()).map(({ id, isEnabled }) => ({ id, isEnabled })))
  ipcMain.handle(IpcChannel.ExecutableSave, async (_event, input: unknown) => {
    const executable = validExecutable(input)
    const saved = await repositories.saveRegisteredExecutable({ id: executable.id, absolutePath: executable.absolutePath, isEnabled: executable.isEnabled,
      argumentPolicyJson: JSON.stringify(executable.allowedArgs) })
    return { id: saved.id, isEnabled: saved.isEnabled }
  })
  ipcMain.handle(IpcChannel.ToolExecutionList, async (_event, taskRunId: unknown) => (await repositories.listToolExecutions(validId(taskRunId))).map((item) => ({
    id: item.id, taskRunId: item.taskRunId, toolName: item.toolName, riskLevel: item.riskLevel, status: item.status, resultSummary: item.resultSummary, createdAt: item.createdAt,
  })))
  ipcMain.handle(IpcChannel.ApprovalList, async (_event, taskRunId: unknown) => (await repositories.listApprovalRequests(validId(taskRunId))).map((item) => ({
    id: item.id, toolExecutionId: item.toolExecutionId, requestHash: item.requestHash, status: item.status, expiresAt: item.expiresAt,
  })))
  ipcMain.handle(IpcChannel.WorkspaceList, async (_event, channelId: unknown, path: unknown) => {
    if (typeof path !== 'string') throw new Error('请求无效')
    const channel = await repositories.getChannel(validId(channelId))
    if (!channel) throw new Error('群聊不存在')
    const project = (await repositories.listProjects()).find((item) => item.id === channel.projectId)
    if (!project) throw new Error('项目不存在')
    return listDirectory(project.workspacePath, path)
  })
  ipcMain.handle(IpcChannel.ProjectList, async () => (await repositories.listProjects()).map(projectSummary))
  ipcMain.handle(IpcChannel.ProjectPickWorkspace, async () => {
    const path = await pickWorkspacePath(dialog)
    if (!path) return undefined
    const id = randomUUID()
    workspaceSelections.set(id, path)
    return { id, label: '已选择本地目录' }
  })
  ipcMain.handle(IpcChannel.ProjectCreate, async (_event, input: { name: string; icon?: string; workspaceId: string; firstChannelName?: string }) => {
    const selectedPath = workspaceSelections.get(input.workspaceId)
    if (!selectedPath) throw new Error('本地目录选择已失效，请重新选择')
    workspaceSelections.delete(input.workspaceId)
    const canonicalWorkspacePath = await validateWorkspaceRoot(selectedPath)
    const { project } = await repositories.createProjectWithInitialChannel({
      name: input.name, icon: input.icon, firstChannelName: input.firstChannelName,
      workspacePath: canonicalWorkspacePath,
    })
    return projectSummary(project)
  })
  ipcMain.handle(IpcChannel.ChannelList, (_event, projectId: string) => repositories.listChannels(projectId))
  ipcMain.handle(IpcChannel.ChannelCreate, (_event, input: CreateChannelInput) => repositories.createChannel(input))
  ipcMain.handle(IpcChannel.ChannelSetScheduler, (_event, channelId: unknown, modelConfigId: unknown) => {
    if (modelConfigId !== null && (typeof modelConfigId !== 'string' || !modelConfigId.trim())) throw new Error('调度模型配置无效')
    return repositories.setChannelScheduler(validId(channelId), modelConfigId)
  })
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
  ipcMain.handle(IpcChannel.CloudConsentGrant, async (_event, projectId: string, modelConfigId: string, scope: unknown) => {
    const project = (await repositories.listProjects()).find((item) => item.id === projectId)
    if (!project || !await repositories.getModelConfig(modelConfigId)) throw new Error('项目或模型配置不存在')
    if (!scope || typeof scope !== 'object' || (scope as { allowToolResultUpload?: unknown }).allowToolResultUpload !== true) throw new Error('需要明确授权工具结果上传')
    await repositories.recordCloudConsent(projectId, modelConfigId)
    await repositories.recordToolResultConsent(projectId, modelConfigId, 1)
  })
  ipcMain.handle(IpcChannel.MessageSend, async (event, input: SendMessageInput) => {
    if (!taskRuns || !modelClient) throw new Error('模型服务不可用')
    if (!input || typeof input.content !== 'string' || !input.content.trim()) throw new Error('消息不能为空')
    if (startingChannels.has(input.channelId)) throw new Error('当前群聊已有任务正在运行')
    startingChannels.add(input.channelId)
    try {
      const channel = await repositories.getChannel(input.channelId)
      if (!channel || !await repositories.getModelConfig(input.modelConfigId)) throw new Error('群聊或模型配置不存在')
      if ((await repositories.listTaskRuns(channel.id)).some((run) => ['running', 'cancelling', 'paused'].includes(run.status))) throw new Error('当前群聊已有任务正在运行')
      if (!(await repositories.listChannelAgents(channel.id)).some((member) => member.isEnabled)) await modelClient.requireCloudConsent(channel.projectId, input.modelConfigId)
      const enabled = (await repositories.listChannelAgents(channel.id)).filter((member) => member.isEnabled)
      if (!enabled.length && input.mentions?.length) throw new Error('群聊没有可提及的 Agent')
      if (enabled.length > 1 && !input.mentions?.length && (channel.speakerMode !== 'automatic' || !channel.schedulerModelConfigId)) throw new Error('请先指派下一位 Agent')
      if (enabled.length && !orchestrator) throw new Error('Agent 协作服务不可用')
      const run = await taskRuns.startTaskRun(channel.id, input.modelConfigId, input.content, input.mentions)
      const sender = (event as { sender: StreamSender }).sender
      if (enabled.length && orchestrator) void orchestrator.run({ taskRunId: run.id, projectId: channel.projectId, channelId: channel.id,
        onEvent: async (streamEvent) => { if (!sender.isDestroyed()) sender.send(IpcChannel.MessageStream, streamEvent) },
      })
      else void streamReply(run.id, channel.projectId, input.modelConfigId, channel.id, sender, repositories, taskRuns, modelClient)
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

function projectSummary(project: { id: string; name: string; icon: string | null; createdAt: string; updatedAt: string }) {
  return { id: project.id, name: project.name, icon: project.icon, createdAt: project.createdAt, updatedAt: project.updatedAt }
}

function requireApprovals(value: IpcHandlerDependencies['approvals']): NonNullable<IpcHandlerDependencies['approvals']> {
  if (!value) throw new Error('审批服务不可用')
  return value
}
function requireProcesses(value: IpcHandlerDependencies['processes']): NonNullable<IpcHandlerDependencies['processes']> {
  if (!value) throw new Error('受控进程服务不可用')
  return value
}
function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('请求无效')
  return value
}
function validHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('请求无效')
  return value
}
function safeApproval(value: { id: string; status: string }): { id: string; status: string } { return { id: value.id, status: value.status } }
function validExecutable(value: unknown): RegisteredExecutableInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('登记程序无效')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 4 || !Object.hasOwn(input, 'id') || !Object.hasOwn(input, 'absolutePath') || !Object.hasOwn(input, 'isEnabled') || !Object.hasOwn(input, 'allowedArgs')
    || typeof input.absolutePath !== 'string' || !/^[A-Za-z]:\\[^\r\n]{1,1024}$/.test(input.absolutePath) || typeof input.isEnabled !== 'boolean'
    || !Array.isArray(input.allowedArgs) || input.allowedArgs.length > 32 || input.allowedArgs.some((arg) => typeof arg !== 'string' || !arg || arg === '*' || arg.length > 1024 || /[|&;<>`$\r\n]/.test(arg))
    || hasWindowsAliasSegment(input.absolutePath) || !isSafeRegisteredExecutable(input.absolutePath, input.allowedArgs as string[])) throw new Error('登记程序无效')
  return { id: validId(input.id), absolutePath: input.absolutePath, isEnabled: input.isEnabled, allowedArgs: input.allowedArgs as string[] }
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
    let routeRevoked = false
    await modelClient.streamChat({ projectId, modelConfigId, taskRunId,
      messages: history.map((message) => ({ role: message.role === 'ceo' ? 'user' : 'assistant', content: message.content })),
    }, accept, async () => {
      const allowed = await taskRuns.canAcceptChunk(taskRunId)
        && !(await repositories.listChannelAgents(channelId)).some((member) => member.isEnabled)
      if (!allowed) routeRevoked = true
      return allowed
    })
    if (routeRevoked && await taskRuns.canAcceptChunk(taskRunId)) {
      const message = '群聊 Agent 配置已变化，请重新发起任务'
      const failed = await repositories.transitionTaskRun(taskRunId, 'running', 'failed', { errorMessage: message })
      if (failed && !sender.isDestroyed()) sender.send(IpcChannel.MessageStream, { taskRunId, type: 'error', content: message })
    }
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
