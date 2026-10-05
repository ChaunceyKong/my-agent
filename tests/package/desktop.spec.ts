import { test, expect, _electron, type ElectronApplication } from 'playwright/test'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { createServer } from 'node:http'

for (const [kind, relative] of [['unpacked', 'win-unpacked/Agent Team Desktop.exe']] as const) {
  test(`${kind} packaged executable persists isolated SQLite and theme with a narrow disabled updater`, async () => {
    const root = await mkdtemp(join(tmpdir(), `agent-team-package-${kind}-`))
    const userData = join(root, 'user-data'); const workspace = join(root, 'workspace')
    await mkdir(userData); await mkdir(workspace)
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE'].includes(entry[0])))
    const launch = () => _electron.launch({ executablePath: resolve('release/win-v0.5.1', relative), args: [`--user-data-dir=${userData}`], env, timeout: 30_000 })
    let app: ElectronApplication | undefined
    let modelRequests = 0
    const server = createServer((_request, response) => { modelRequests++; response.writeHead(503).end() })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing package test provider')
    const modelUrl = `http://127.0.0.1:${address.port}/v1`
    try {
      app = await launch()
      let page = await app.firstWindow()
      await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
      const main = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), path: app.getAppPath(), userData: app.getPath('userData') }))
      expect(main).toMatchObject({ packaged: true, version: '0.5.1', userData })
      expect(main.path).toMatch(/app\.asar$/)
      await app.evaluate(({ session }) => {
        ;(globalThis as unknown as { packageRequests: string[] }).packageRequests = []
        session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
          ;(globalThis as unknown as { packageRequests: string[] }).packageRequests.push(details.url); callback({})
        })
      })
      const api = await page.evaluate(async () => {
        const updates = window.agentTeam.updates
        return { node: typeof (window as unknown as { require?: unknown }).require, keys: Object.keys(window.agentTeam),
          updates: await Promise.all([updates.status(), updates.check(), updates.download(), updates.install(), updates.cancel()]) }
      })
      expect(api.node).toBe('undefined')
      for (const key of ['invoke', 'fs', 'shell', 'process', 'database', 'credentials', 'setFeedURL']) expect(api.keys).not.toContain(key)
      expect(api.updates).toEqual(Array(5).fill({ state: 'disabled', reason: 'unconfigured', progress: null, cancellable: false }))
      await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('dark')
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(page.getByText('v0.5.1', { exact: true })).toBeVisible()
      // Substitute only the OS dialog result in test Main. The production opaque selection
      // and project IPC are unchanged. This is not evidence of manual native chooser UX.
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, workspace)
      await page.getByRole('button', { name: '新建项目', exact: true }).click()
      await page.getByLabel('项目名称', { exact: true }).fill('打包隔离项目')
      await page.getByLabel('本地目录', { exact: true }).click()
      await page.getByRole('button', { name: '确认创建项目', exact: true }).click()
      await expect(page.getByRole('heading', { name: '主线任务协同群', exact: true })).toBeVisible()
      await page.evaluate(async (baseUrl) => {
        const model = await window.agentTeam.models.save({ providerPreset: 'ollama', baseUrl, modelName: 'package-roster', apiKey: '' })
        const [project] = await window.agentTeam.projects.list()
        const [channel] = await window.agentTeam.channels.list(project.id)
        for (let index = 1; index <= 5; index++) {
          const agent = await window.agentTeam.agents.create({ name: `打包成员${index}`, title: `角色${index}`, avatar: null, systemPrompt: '仅用于隔离打包测试', modelConfigId: model.id, defaultToolPermissions: {} })
          await window.agentTeam.channelAgents.save({ channelId: channel.id, agentId: agent.id, isEnabled: true, modelConfigOverrideId: null, toolPermissionsOverride: null })
        }
      }, modelUrl)
      await page.reload()
      await page.getByLabel('消息内容', { exact: true }).fill('当前群聊有多少位 Agent？请列出名单和启用状态。')
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(page.getByRole('log').getByRole('table').getByRole('row')).toHaveCount(6)
      await expect(page.getByRole('log').locator('strong').filter({ hasText: '5 位已启用' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'CEO 任务控制' })).toHaveCount(0)
      expect(modelRequests).toBe(0)
      expect(await app.evaluate(() => (globalThis as unknown as { packageRequests: string[] }).packageRequests)).toEqual([])
      await page.screenshot({ path: `test-results/package-${kind}-dark.png`, fullPage: true })
      await app.close(); app = undefined
      // Read the database created by packaged Main, not a mocked or developer service.
      const db = new Database(join(userData, 'agent-team.sqlite'), { fileMustExist: true })
      try {
        expect(db.prepare('SELECT name, workspace_path FROM projects').all()).toEqual([{ name: '打包隔离项目', workspace_path: workspace }])
        expect(db.pragma('user_version', { simple: true })).toBe(18)
        expect(db.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({ count: 1 })
        // Reproduce an idle v0.5.0 routing pause in this test's isolated database.
        const run = db.prepare('SELECT id, generation FROM task_runs LIMIT 1').get() as { id: string; generation: number }
        const agent = db.prepare('SELECT id FROM agents LIMIT 1').get() as { id: string }
        db.prepare("INSERT INTO agent_turns(id, task_run_id, ordinal, agent_id, generation, status, trigger_event_seq) VALUES(?,?,?,?,?,'completed',1)").run('legacy-turn', run.id, 1, agent.id, run.generation)
        db.prepare("UPDATE task_runs SET status='paused', turn_count=1, pause_reason='自动调度不可用，请 CEO 指派下一位 Agent。', finished_at=NULL WHERE id=?").run(run.id)
      } finally { db.close() }
      app = await launch(); page = await app.firstWindow()
      await expect(page.getByRole('heading', { name: '主线任务协同群', exact: true })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      expect(await page.evaluate(() => window.agentTeam.projects.list())).toEqual([expect.objectContaining({ name: '打包隔离项目' })])
      await expect(page.getByRole('log').getByRole('table').getByRole('row')).toHaveCount(6)
      await expect(page.getByRole('region', { name: 'CEO 任务控制' })).toHaveCount(0)
      expect(await page.evaluate(async () => {
        const [project] = await window.agentTeam.projects.list()
        const [channel] = await window.agentTeam.channels.list(project.id)
        return (await window.agentTeam.tasks.snapshot(channel.id)).runs[0].status
      })).toBe('completed')
      expect((await page.evaluate(() => window.agentTeam.updates.status())).state).toBe('disabled')
      // Successful packaged read/write/restart proves the bundled native SQLite loaded.
      expect((await readFile(join(userData, 'agent-team.sqlite'))).subarray(0, 16).toString()).toBe('SQLite format 3\0')
      console.log('PACKAGE_SMOKE', JSON.stringify({ kind, version: main.version, packaged: main.packaged, asar: true, isolatedDatabase: true, nativeSqlitePersistence: true, themeRestart: true, observedSessionHttpRequestsAfterReady: 0, picker: 'Main-dialog-substitution-only' }))
    } finally {
      await app?.close()
      await new Promise<void>((done) => server.close(() => done()))
      // root is exactly this test's mkdtemp result, never a workspace/user-data root.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
}
