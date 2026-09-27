import { test as base, expect, _electron, type ElectronApplication, type Page } from 'playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type ServerResponse } from 'node:http'

interface Desktop {
  app: ElectronApplication
  page: Page
  userData: string
  workspace: string
  restart(): Promise<void>
}

interface RequestBody { model: string; messages: Array<{ role: string; content: string }>; stream: boolean }
interface Provider {
  url: string
  requests: RequestBody[]
  disconnectedRequests: number[]
  delta(content: string): void
  complete(): void
  fail(): void
  truncate(): void
}

export const test = base.extend<{ desktop: Desktop; provider: Provider }>({
  provider: async ({}, use) => {
    let response: ServerResponse | undefined
    const requests: RequestBody[] = []
    const disconnectedRequests: number[] = []
    const server = createServer(async (request, outgoing) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        outgoing.writeHead(404).end()
        return
      }
      let body = ''
      for await (const part of request) body += part
      requests.push(JSON.parse(body) as RequestBody)
      const requestIndex = requests.length - 1
      outgoing.on('close', () => { disconnectedRequests.push(requestIndex) })
      response = outgoing
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback server address')
    const write = (data: string) => {
      if (!response || response.destroyed) throw new Error('No active model request')
      if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${data}\n\n`)
    }
    try {
      await use({
        url: `http://127.0.0.1:${address.port}/v1`, requests, disconnectedRequests,
        delta(content) { write(JSON.stringify({ choices: [{ delta: { content } }] })) },
        complete() { write('[DONE]'); response!.end() },
        fail() { response!.writeHead(401).end('private provider diagnostic') },
        truncate() { response!.end() },
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  },
  desktop: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-e2e-'))
    const userData = join(root, 'user-data')
    const workspace = join(root, 'workspace')
    await mkdir(userData)
    await mkdir(workspace)
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(entry[0])))
    const launch = () => _electron.launch({
      args: [resolve('out/main/main.js'), `--user-data-dir=${userData}`],
      env,
    })
    let app: ElectronApplication | undefined
    try {
      app = await launch()
      const desktop: Desktop = {
        app, page: await app.firstWindow(), userData, workspace,
        async restart() {
          await desktop.app.close()
          app = await launch()
          desktop.app = app
          desktop.page = await app.firstWindow()
          await expect(desktop.page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
        },
      }
      expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)
      await expect(desktop.page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
      await use(desktop)
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  },
})

export { expect }

export async function createProject(desktop: Desktop) {
  const { page } = desktop
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('项目名称', { exact: true }).fill('端到端演示项目')
  await page.getByLabel('本地目录', { exact: true }).evaluate((element, value) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, desktop.workspace)
  await page.getByRole('button', { name: '确认创建项目', exact: true }).click()
  await expect(page.getByRole('heading', { name: '主线任务协同群', exact: true })).toBeVisible()
  await expect(page.getByLabel('消息内容', { exact: true })).toBeEnabled()
}

export async function configureModel(page: Page, url: string) {
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await page.getByRole('combobox', { name: '模型服务商', exact: true }).selectOption('openai')
  await page.getByLabel('服务地址', { exact: true }).fill(url)
  await page.getByLabel('模型名称', { exact: true }).fill('local-e2e-model')
  await page.getByLabel('API Key', { exact: true }).fill('e2e-local-only-key')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('对话模型').locator('option:checked')).toHaveText('local-e2e-model')
}

export async function sendWithConsent(page: Page, content: string) {
  await page.getByLabel('消息内容', { exact: true }).fill(content)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await page.getByRole('button', { name: '同意并发送', exact: true }).click()
}
