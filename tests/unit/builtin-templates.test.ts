import { describe, expect, it } from 'vitest'
import { getBuiltinTemplate, listBuiltinTemplates } from '../../electron/core/builtin-templates'

const expectedNames = {
  media: ['内容主编 (PM)', '选题策划师', '爆款文案/脚本师', '排版与SEO优化师', '平台合规质检员'],
  business: ['创业咨询顾问', '商业模式架构师 (Lean Canvas)', '市场竞品分析员', '财务测算师', '风险评估官'],
  literature: ['故事架构总策划', '世界观/设定专家', '人物对白专职作者', '剧情冲突推演师', '文学审校编辑'],
  dev: ['技术主管', '全栈开发工程师', '代码质检员 (QA)', 'DevOps/运维专家'],
}

describe('built-in template catalog', () => {
  it('contains exactly the four PRD teams and their 5 / 5 / 5 / 4 roles', () => {
    const summaries = listBuiltinTemplates()
    expect(summaries.map((item) => item.id)).toEqual(Object.keys(expectedNames))
    expect(summaries.map((item) => item.roleCount)).toEqual([5, 5, 5, 4])
    for (const summary of summaries) {
      const names = expectedNames[summary.id as keyof typeof expectedNames]
      const template = getBuiltinTemplate(summary.id)!
      expect(summary.roleNames).toEqual(names)
      expect(template.roles.map((item) => item.name)).toEqual(names)
      expect(new Set(template.roles.map((item) => item.id)).size).toBe(template.roles.length)
      expect(template.name).toBe(summary.name)
      expect(template.avatar).toBe(summary.avatar)
      expect(template.description).toBe(summary.description)
    }
  })

  it('gives every role a distinct professional prompt, responsibilities and output contract', () => {
    const roles = listBuiltinTemplates().flatMap((item) => getBuiltinTemplate(item.id)!.roles)
    expect(new Set(roles.map((item) => item.systemPrompt)).size).toBe(19)
    for (const item of roles) {
      expect(item.id).toMatch(/^[a-z]+$/)
      expect(item.avatar.length).toBeGreaterThan(0)
      expect(item.title.length).toBeGreaterThan(4)
      expect(item.responsibilities).toHaveLength(3)
      expect(item.systemPrompt).toContain(item.name)
      expect(item.systemPrompt).toContain(item.title)
      expect(item.systemPrompt).toContain(item.outputFormat)
      for (const responsibility of item.responsibilities) expect(item.systemPrompt).toContain(responsibility)
    }
    expect(getBuiltinTemplate('business')!.roles[1].systemPrompt).toContain('九模块')
    expect(getBuiltinTemplate('literature')!.roles[3].systemPrompt).toContain('因果')
    expect(getBuiltinTemplate('media')!.roles[2].systemPrompt).toContain('分镜')
    expect(getBuiltinTemplate('dev')!.roles[2].systemPrompt).toContain('可复现')
  })

  it('keeps tools, evidence, side effects and secrets under application control', () => {
    for (const summary of listBuiltinTemplates()) {
      const template = getBuiltinTemplate(summary.id)!
      expect(Object.keys(template)).toEqual(['id', 'name', 'avatar', 'description', 'roles'])
      for (const item of template.roles) {
        expect(Object.keys(item)).toEqual(['id', 'name', 'avatar', 'title', 'responsibilities', 'outputFormat', 'systemPrompt'])
        expect(item.systemPrompt).toContain('不虚构引用、数据、测试结果或执行记录')
        expect(item.systemPrompt).toContain('没有真实工具结果，不得声称')
        expect(item.systemPrompt).toContain('模板不授予文件读写、进程执行、网络访问或其他副作用权限')
        expect(item.systemPrompt).toContain('未经批准不得执行')
        expect(item.systemPrompt).toContain('不要要求或输出 API Key 等秘密')
        expect(item.systemPrompt).not.toMatch(/(?:你有|已授予|自动获得)(?:全部|所有|文件|执行|管理员)/)
      }
    }
  })

  it('returns isolated mutable copies for previews and copy-to-edit', () => {
    const original = getBuiltinTemplate('media')!
    const edited = getBuiltinTemplate('media')!
    edited.name = 'changed'
    edited.roles[0].systemPrompt = 'changed'
    edited.roles[0].responsibilities.push('changed')
    edited.roles.splice(1)
    expect(getBuiltinTemplate('media')).toEqual(original)

    const summaries = listBuiltinTemplates()
    summaries[0].name = 'changed'
    summaries[0].roleNames.push('changed')
    summaries.splice(1)
    expect(listBuiltinTemplates()).toHaveLength(4)
    expect(listBuiltinTemplates()[0].name).toBe(original.name)
    expect(listBuiltinTemplates()[0].roleNames).toEqual(expectedNames.media)
  })

  it('does not expose another template or inherited property for unknown IDs', () => {
    for (const id of ['', 'unknown', '__proto__', 'constructor', 'toString', 'MEDIA']) {
      expect(getBuiltinTemplate(id)).toBeUndefined()
    }
  })
})
