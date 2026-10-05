import { test, expect, createProject, configureModel, createAndBindAgent, sendWithConsent } from './fixtures'

test('five enabled Agents are listed locally despite a prior model denial; state changes and group isolation stay accurate', async ({ desktop, provider }) => {
  const { page } = desktop
  await page.setViewportSize({ width: 1440, height: 1050 })
  await createProject(desktop)
  await configureModel(page, provider.url)
  const names = ['内容主编', '选题策划师', '文案脚本师', '排版优化师', '合规质检员']
  for (const name of names) await createAndBindAgent(page, [], name)
  const [project] = await page.evaluate(() => window.agentTeam.projects.list())
  const [main] = await page.evaluate((id) => window.agentTeam.channels.list(id), project.id)
  await sendWithConsent(page, '请先回答一个普通问题')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.delta('我没有群聊成员信息，只知道自己。'); provider.complete()
  await expect(page.getByRole('region', { name: 'CEO 任务控制' })).toHaveCount(0)

  const ask = async (question = '当前群聊有多少位 Agent？请列出名单和启用状态。') => {
    await page.getByLabel('消息内容', { exact: true }).fill(question)
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((id) => window.agentTeam.tasks.snapshot(id), main.id)).runs.at(-1)?.status).toBe('completed')
  }
  await ask()
  const log = page.getByRole('log', { name: '群聊消息', exact: true })
  await expect(log.getByRole('table').last()).toHaveCount(1)
  await expect(log.getByRole('table').last().getByRole('row')).toHaveCount(6)
  for (const name of names) await expect(log.getByRole('table').last()).toContainText(name)
  await expect(log.locator('strong').filter({ hasText: '5 位已启用' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '云端模型授权' })).toHaveCount(0)
  expect(provider.requests).toHaveLength(1)
  await page.screenshot({ path: 'test-results/channel-roster-five.png' })

  await page.getByRole('button', { name: '停用群聊 Agent：合规质检员', exact: true }).click()
  await ask('项目群聊中加入的agent成员有哪些？')
  await expect(log.getByRole('table').last()).toContainText('已停用')
  await expect(log.locator('strong').filter({ hasText: '4 位已启用' }).last()).toBeVisible()
  await page.getByRole('button', { name: '移出群聊：合规质检员', exact: true }).click()
  await ask()
  await expect(log.getByRole('table').last().getByRole('row')).toHaveCount(5)
  await expect(log.getByRole('table').last()).not.toContainText('合规质检员')
  expect(provider.requests).toHaveLength(1)
  await desktop.restart()
  await expect(desktop.page.getByRole('region', { name: 'CEO 任务控制' })).toHaveCount(0)
  await expect(desktop.page.getByRole('log').getByRole('table').last().getByRole('row')).toHaveCount(5)
  expect(provider.requests).toHaveLength(1)
})
