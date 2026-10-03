import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, configureModel, createAndBindAgent, createProject, sendWithConsent } from './fixtures'

test('strict diagnostics and native export never copy injected private log payloads', async ({ desktop }) => {
  const { page, app, userData } = desktop
  const rejected = await page.evaluate(async () => {
    try { await window.agentTeam.diagnostics.report({ code: 'renderer_render_failed', secret: 'PRIVATE_KEY_SENTINEL' } as never); return false } catch { return true }
  })
  expect(rejected).toBe(true)
  await page.evaluate(async () => { try { await window.agentTeam.agents.get('invalid/PRIVATE_WORKSPACE'); } catch {} })
  const directory = join(userData, 'logs')
  const files = await readdir(directory)
  const log = await readFile(join(directory, files[0]), 'utf8')
  expect(log).toContain('ipc_failed')
  expect(log).toContain('agent:get')
  expect(log).not.toContain('PRIVATE')
  const valid = JSON.parse(log.split('\n')[0])
  await writeFile(join(directory, files[0]), log + JSON.stringify({ ...valid, stack: 'PRIVATE_BODY_SENTINEL' }) + '\nPRIVATE_PROVIDER_BODY\n')
  const output = join(userData, 'chosen-export.log')
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath }) }, output)
  expect(await page.evaluate(() => window.agentTeam.diagnostics.export())).toEqual({ status: 'cancelled' })
  expect(await readdir(userData)).not.toContain('chosen-export.log')
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, output)
  const result = await page.evaluate(() => window.agentTeam.diagnostics.export())
  expect(result).toEqual({ status: 'exported' })
  expect(await readFile(output, 'utf8')).toBe(log)
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, userData)
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await page.getByRole('button', { name: '导出诊断日志', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('诊断日志导出失败')
  expect(await page.locator('body').innerText()).not.toContain(userData)
})

test('unexpected-error recovery reloads UI without replaying a running file effect', async ({ desktop, provider }) => {
  const { page } = desktop
  await page.setViewportSize({ width: 900, height: 900 })
  await createProject(desktop)
  await configureModel(page, provider.url)
  await createAndBindAgent(page, ['write_file'])
  await page.getByRole('button', { name: '收起右侧面板', exact: true }).click()
  await sendWithConsent(page, '创建文件后等待模型结束')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.toolCall('write_file', { path: 'one-effect.md', content: 'ONE_DURABLE_EFFECT' }, 'only-write')
  await expect.poll(() => provider.requests.length).toBe(2)
  expect(await readFile(join(desktop.workspace, 'one-effect.md'), 'utf8')).toBe('ONE_DURABLE_EFFECT')
  // Trigger an actual React render exception from the message timestamp renderer,
  // not fake DOM or a production-only testing hook. The poll drives a real render.
  await page.evaluate(() => { Date.prototype.toLocaleTimeString = () => { throw new Error('PRIVATE_RENDER_STACK') } })
  await expect(page.getByRole('heading', { name: '界面出现意外错误', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).not.toContainText('PRIVATE_RENDER_STACK')
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
    await mkdir('test-results', { recursive: true })
    await page.screenshot({ path: `test-results/v05-diagnostics-boundary-${theme}.png`, fullPage: true })
  }
  await page.getByRole('button', { name: '重新加载界面', exact: true }).click()
  await expect(page.getByLabel('消息内容', { exact: true })).toBeVisible()
  expect(provider.requests).toHaveLength(2)
  const tools = await page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [run] = await window.agentTeam.tasks.list(channel.id)
    return window.agentTeam.tools.list(run.id)
  })
  expect(tools).toHaveLength(1)
  expect(tools[0]).toMatchObject({ toolName: 'write_file', status: 'completed' })
  provider.delta('文件已创建。'); provider.complete()
  await expect(page.getByText('已完成', { exact: true })).toBeVisible()
  expect(await readFile(join(desktop.workspace, 'one-effect.md'), 'utf8')).toBe('ONE_DURABLE_EFFECT')
  const logs = await readdir(join(desktop.userData, 'logs'))
  const content = await readFile(join(desktop.userData, 'logs', logs[0]), 'utf8')
  expect(content).toContain('renderer_render_failed')
  expect(content).not.toMatch(/PRIVATE_RENDER_STACK|ONE_DURABLE_EFFECT|e2e-local-only-key/)
})

test('browser offline and global errors remain hints without disabling local Ollama controls', async ({ desktop, provider }) => {
  const { page } = desktop
  await page.setViewportSize({ width: 900, height: 900 })
  await createProject(desktop)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_EVENT_MESSAGE', error: new Error('PRIVATE_STACK') }))
    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: 'PRIVATE_REJECTION' }))
  })
  await expect(page.getByRole('status')).toContainText('本地操作和 Ollama 仍可使用')
  await expect(page.getByRole('alert')).toContainText('界面发生意外错误')
  const layout = await page.evaluate(() => ({
    headerBottom: document.querySelector('.app-header')!.getBoundingClientRect().bottom,
    panelTop: document.querySelector('.right-cockpit')!.getBoundingClientRect().top,
  }))
  expect(layout.panelTop).toBeGreaterThanOrEqual(layout.headerBottom)
  await expect(page.getByLabel('界面主题', { exact: true })).toBeVisible()
  await page.getByLabel('界面主题', { exact: true }).selectOption('dark')
  await page.screenshot({ path: 'test-results/v05-diagnostics-narrow-dark.png', fullPage: true })
  await page.getByLabel('界面主题', { exact: true }).selectOption('light')
  await page.screenshot({ path: 'test-results/v05-diagnostics-narrow-light.png', fullPage: true })
  await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '模型设置', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: '模型服务商', exact: true }).selectOption('ollama')
  await page.getByLabel('服务地址', { exact: true }).fill(provider.url)
  await expect(page.getByRole('button', { name: '发现本机模型', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '发现本机模型', exact: true }).click()
  await expect.poll(() => provider.ollamaChecks.length).toBeGreaterThan(0)
  expect(provider.requests).toHaveLength(0)
  const logs = await readdir(join(desktop.userData, 'logs'))
  const content = await readFile(join(desktop.userData, 'logs', logs[0]), 'utf8')
  expect(content).toContain('renderer_unhandled_error')
  expect(content).toContain('renderer_unhandled_rejection')
  expect(content).not.toContain('PRIVATE')
})
