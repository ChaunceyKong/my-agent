import { test, expect, createProject, configureModel, sendWithConsent } from './fixtures'

test('creates a project, switches channels, and persists navigation across app restarts', async ({ desktop }) => {
  await createProject(desktop)
  const { page } = desktop
  await page.getByRole('button', { name: '新建会话群聊', exact: true }).click()
  await page.getByLabel('群聊名称', { exact: true }).fill('独立讨论群')
  await page.getByRole('button', { name: '确认建群', exact: true }).click()
  await expect(page.getByRole('heading', { name: '独立讨论群', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '主线任务协同群', exact: true }).click()
  await expect(page.getByRole('heading', { name: '主线任务协同群', exact: true })).toBeVisible()
  await desktop.restart()
  await expect(desktop.page.getByLabel('选择项目').locator('option:checked')).toHaveText('端到端演示项目')
  await desktop.page.getByRole('button', { name: '独立讨论群', exact: true }).click()
  await expect(desktop.page.getByRole('heading', { name: '独立讨论群', exact: true })).toBeVisible()
})

test('requires model configuration without fabricating a response', async ({ desktop }) => {
  await createProject(desktop)
  const { page } = desktop
  await page.getByLabel('消息内容', { exact: true }).fill('未配置模型的测试')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '配置模型', exact: true })).toBeVisible()
  await page.getByLabel('消息内容', { exact: true }).press('Enter')
  await expect(page.getByRole('log').getByRole('article')).toHaveCount(0)
  const history = await page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    return { messages: await window.agentTeam.messages.list(channel.id), runs: await window.agentTeam.tasks.list(channel.id) }
  })
  expect(history).toEqual({ messages: [], runs: [] })
})

test('enforces consent and restores the full durable reply after a mid-stream reload and restart', async ({ desktop, provider }) => {
  await createProject(desktop)
  const { page } = desktop
  await configureModel(page, provider.url)
  expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe('undefined')
  expect(await page.evaluate(() => typeof (window as unknown as { process?: unknown }).process)).toBe('undefined')
  const models = await page.evaluate(() => window.agentTeam.models.list())
  expect(models).toEqual([expect.objectContaining({ modelName: 'local-e2e-model', hasApiKey: true })])
  expect(JSON.stringify(models)).not.toContain('e2e-local-only-key')
  expect(models[0]).not.toHaveProperty('encryptedApiKey')

  await page.getByLabel('消息内容', { exact: true }).fill('请测试持久化')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '云端模型授权' })).toContainText(provider.url)
  const beforeConsent = await page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [model] = await window.agentTeam.models.list()
    let rejected = false
    try { await window.agentTeam.tasks.send({ channelId: channel.id, modelConfigId: model.id, content: '未授权调用' }) }
    catch { rejected = true }
    return { rejected, messages: await window.agentTeam.messages.list(channel.id), runs: await window.agentTeam.tasks.list(channel.id) }
  })
  expect(beforeConsent).toEqual({ rejected: true, messages: [], runs: [] })
  expect(provider.requests).toHaveLength(0)
  await page.getByRole('dialog', { name: '云端模型授权' }).getByRole('checkbox').check()
  await page.getByRole('button', { name: '同意并发送', exact: true }).click()
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.delta('重载前的完整前缀。')
  await expect(page.getByRole('log')).toContainText('重载前的完整前缀。')
  await page.reload()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  provider.delta('重载后的后缀。')
  provider.complete()
  await expect(page.getByRole('log')).toContainText('重载前的完整前缀。重载后的后缀。')
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()

  await desktop.restart()
  await expect(desktop.page.getByRole('log')).toContainText('重载前的完整前缀。重载后的后缀。')
  await expect(desktop.page.getByRole('log').getByRole('article')).toHaveCount(2)
  expect(provider.requests).toHaveLength(1)
  await desktop.page.getByLabel('消息内容', { exact: true }).fill('第二轮对话')
  await desktop.page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => provider.requests.length).toBe(2)
  // v0.3 prepends bounded context/facts as system data; conversation order is unchanged.
  expect(provider.requests[1].messages.filter((message) => message.role !== 'system')).toEqual([
    { role: 'user', content: '请测试持久化' },
    { role: 'assistant', content: '重载前的完整前缀。重载后的后缀。' },
    { role: 'user', content: '第二轮对话' },
  ])
  provider.delta('第二轮完成。')
  provider.complete()
  await expect(desktop.page.getByRole('log')).toContainText('第二轮完成。')
  await expect(desktop.page.getByText('已完成', { exact: true })).toHaveCount(2)
})

test('recovers an interrupted generation as paused without replaying the provider request', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await sendWithConsent(desktop.page, '中断恢复测试')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.delta('尚未完成的临时文本')
  await expect(desktop.page.getByRole('log')).toContainText('尚未完成的临时文本')
  await desktop.restart()
  await expect(desktop.page.getByText('任务已暂停，应用重启后不会自动续跑', { exact: true })).toBeVisible()
  await expect(desktop.page.getByRole('log')).toContainText('中断恢复测试')
  await expect(desktop.page.getByRole('log')).not.toContainText('尚未完成的临时文本')
  await expect(desktop.page.getByRole('log').getByRole('article')).toHaveCount(1)
  expect(provider.requests).toHaveLength(1)
})

test('persists a sanitized provider failure without a fabricated completed reply', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await sendWithConsent(desktop.page, '失败恢复测试')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.fail()
  await expect(desktop.page.getByRole('log')).toContainText('模型服务拒绝凭证，请检查 API 密钥配置')
  const state = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    return window.agentTeam.tasks.snapshot(channel.id)
  })
  expect(state.runs.at(-1)?.status).toBe('paused')
  expect(state.messages.some((message) => message.role === 'agent' && message.status === 'completed')).toBe(false)
  await desktop.restart()
  await expect(desktop.page.getByRole('log')).toContainText('模型服务拒绝凭证，请检查 API 密钥配置')
  await expect(desktop.page.getByRole('log').getByRole('article')).toHaveCount(1)
  await expect(desktop.page.getByRole('log')).not.toContainText('private provider diagnostic')
  expect(provider.requests).toHaveLength(1)
})

test('stopping generation disconnects the pending provider request and allows the next reply', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await sendWithConsent(desktop.page, '取消等待响应')
  await expect.poll(() => provider.requests.length).toBe(1)
  await desktop.page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect.poll(() => provider.disconnectedRequests).toContain(0)
  await desktop.page.getByLabel('消息内容', { exact: true }).fill('取消后继续')
  await desktop.page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => provider.requests.length).toBe(2)
  provider.delta('新任务完成')
  provider.complete()
  await expect(desktop.page.getByText('已完成', { exact: true })).toHaveCount(1)
  await desktop.restart()
  await expect(desktop.page.getByRole('log').getByRole('article')).toHaveCount(3)
  await expect(desktop.page.getByRole('log')).toContainText('新任务完成')
})

test('a truncated successful HTTP stream fails without persisting a partial reply', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await sendWithConsent(desktop.page, '响应截断测试')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.delta('只收到一半')
  await expect(desktop.page.getByRole('log')).toContainText('只收到一半')
  provider.truncate()
  await expect(desktop.page.getByRole('alert')).toHaveText('模型响应格式异常，请稍后重试')
  await desktop.restart()
  await expect(desktop.page.getByRole('log').getByRole('article')).toHaveCount(1)
  await expect(desktop.page.getByRole('log')).toContainText('生成失败 · 模型响应格式异常，请稍后重试')
  await expect(desktop.page.getByRole('log')).not.toContainText('只收到一半')
})
