import type { Agent, AgentEditorInput, AgentSummary, SaveChannelAgentInput, ToolName, ToolPermissions } from '../../shared/types'
import type { Repositories } from '../database/repositories'

const toolNames: ToolName[] = ['list_dir', 'read_file', 'search_files', 'write_file', 'run_process']

function requireText(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label}无效`)
  return value
}

function permissions(value: unknown): ToolPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具权限无效')
  const result: ToolPermissions = {}
  for (const [key, enabled] of Object.entries(value)) {
    // Compatibility alias only: its authority is always write_file and it is never
    // stored as an independently grantable capability.
    if (key === 'replace_file_content' && typeof enabled === 'boolean') continue
    if (!toolNames.includes(key as ToolName) || typeof enabled !== 'boolean') throw new Error('工具权限无效')
    result[key as ToolName] = enabled
  }
  return result
}

function summary(agent: Agent): AgentSummary {
  return {
    id: agent.id, name: agent.name, avatar: agent.avatar, title: agent.title,
    modelConfigId: agent.modelConfigId, defaultToolPermissions: agent.defaultToolPermissions,
    isBuiltin: agent.isBuiltin, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
  }
}

export function createAgentService(repositories: Repositories) {
  async function requireModel(id: string): Promise<void> {
    requireText(id, '模型配置')
    if (!await repositories.getModelConfig(id)) throw new Error('模型配置不存在')
  }

  async function get(id: string): Promise<Agent> {
    requireText(id, 'Agent ID')
    const agent = await repositories.getAgent(id)
    if (!agent) throw new Error('Agent 不存在')
    return agent
  }

  async function requireChannel(id: string): Promise<void> {
    requireText(id, '群聊 ID')
    if (!await repositories.getChannel(id)) throw new Error('群聊不存在')
  }

  async function editorInput(input: AgentEditorInput): Promise<AgentEditorInput> {
    if (!input || typeof input !== 'object') throw new Error('Agent 配置无效')
    const validated: AgentEditorInput = {
      name: requireText(input.name, 'Agent 名称').trim(),
      avatar: input.avatar === null ? null : requireText(input.avatar, 'Agent 头像', true),
      title: requireText(input.title, 'Agent 职位', true),
      systemPrompt: requireText(input.systemPrompt, '系统提示词', true),
      modelConfigId: requireText(input.modelConfigId, '模型配置'),
      defaultToolPermissions: permissions(input.defaultToolPermissions),
    }
    await requireModel(validated.modelConfigId)
    return validated
  }

  return {
    async list(): Promise<AgentSummary[]> {
      return (await repositories.listAgents()).map(summary)
    },
    get,
    async create(input: AgentEditorInput): Promise<AgentSummary> {
      return summary(await repositories.createAgent(await editorInput(input)))
    },
    async update(id: string, input: AgentEditorInput): Promise<AgentSummary> {
      await get(id)
      const agent = await repositories.updateAgent(id, await editorInput(input))
      if (!agent) throw new Error('Agent 不存在')
      return summary(agent)
    },
    async remove(id: string): Promise<void> {
      await get(id)
      await repositories.removeAgent(id)
    },
    async listChannelAgents(channelId: string) {
      await requireChannel(channelId)
      return repositories.listChannelAgents(channelId)
    },
    async saveChannelAgent(input: SaveChannelAgentInput) {
      if (!input || typeof input !== 'object' || typeof input.isEnabled !== 'boolean') throw new Error('群聊成员配置无效')
      await requireChannel(input.channelId)
      const agent = await get(input.agentId)
      if (input.modelConfigOverrideId !== null) await requireModel(input.modelConfigOverrideId)
      const override = input.toolPermissionsOverride === null ? null : permissions(input.toolPermissionsOverride)
      if (override) {
        for (const name of toolNames) {
          if (override[name] === true && agent.defaultToolPermissions[name] !== true) throw new Error('群聊权限不能超出 Agent 默认权限')
        }
      }
      return repositories.saveChannelAgent({
        channelId: input.channelId, agentId: input.agentId, isEnabled: input.isEnabled,
        modelConfigOverrideId: input.modelConfigOverrideId, toolPermissionsOverride: override,
      })
    },
    async removeChannelAgent(channelId: string, agentId: string): Promise<void> {
      await requireChannel(channelId)
      await get(agentId)
      await repositories.removeChannelAgent(channelId, agentId)
    },
  }
}
