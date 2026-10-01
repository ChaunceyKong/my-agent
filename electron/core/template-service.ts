import type { AgentTemplateImportResult, CopyAgentTemplateInput, ImportAgentTemplateInput } from '../../shared/types'
import type { Repositories } from '../database/repositories'
import { agentSummary, validateAgentEditorInput } from './agent-service'
import { getBuiltinTemplate, listBuiltinTemplates } from './builtin-templates'

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('模板请求无效')
  return value
}

function fields(value: unknown, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error('模板请求无效')
}

export function createTemplateService(repositories: Repositories) {
  function get(templateId: string) {
    const template = getBuiltinTemplate(id(templateId))
    if (!template) throw new Error('内置模板不存在')
    return template
  }

  async function save(templateId: string, channelId: string, copies: CopyAgentTemplateInput['editor'][]): Promise<AgentTemplateImportResult> {
    const result = await repositories.createTemplateAgents({ templateId, channelId, copies })
    return { agents: result.agents.map(agentSummary), members: result.members }
  }

  return {
    async list() { return listBuiltinTemplates() },
    async get(templateId: string) { return get(templateId) },
    async importTeam(input: ImportAgentTemplateInput): Promise<AgentTemplateImportResult> {
      fields(input, ['templateId', 'channelId', 'modelConfigId'])
      const template = get(input.templateId)
      const modelConfigId = id(input.modelConfigId)
      return save(template.id, id(input.channelId), template.roles.map((role) => ({
        name: role.name, avatar: role.avatar, title: role.title, systemPrompt: role.systemPrompt, modelConfigId,
      })))
    },
    async copyAgent(input: CopyAgentTemplateInput): Promise<AgentTemplateImportResult> {
      fields(input, ['templateId', 'roleId', 'channelId', 'editor'])
      const template = get(input.templateId)
      if (!template.roles.some((role) => role.id === id(input.roleId))) throw new Error('模板角色不存在')
      fields(input.editor, ['name', 'avatar', 'title', 'systemPrompt', 'modelConfigId'])
      const editor = validateAgentEditorInput({ ...input.editor, defaultToolPermissions: {} })
      if (/[\u0000-\u001f\u007f@]/u.test(editor.name)) throw new Error('Agent 名称不能包含控制字符或 @')
      return save(template.id, id(input.channelId), [{ name: editor.name, avatar: editor.avatar, title: editor.title,
        systemPrompt: editor.systemPrompt, modelConfigId: id(editor.modelConfigId) }])
    },
  }
}
