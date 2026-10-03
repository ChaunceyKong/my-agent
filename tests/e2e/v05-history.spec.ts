import { test, expect, configureModel, createProject, sendWithConsent } from './fixtures'
import Database from 'better-sqlite3'
import { join } from 'node:path'

async function seedHistory(desktop: Parameters<typeof createProject>[0]) {
  const ids = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const [model] = await window.agentTeam.models.list()
    return { channelId: channel.id, modelId: model.id }
  })
  const { channelId, modelId } = ids
  const database = new Database(join(desktop.userData, 'agent-team.sqlite'))
  try {
    database.transaction(() => {
      const message = database.prepare('INSERT INTO messages(id,channel_id,role,author_name,content,status,created_at,actual_model_config_id) VALUES(?,?,?,?,?,?,?,?)')
      for (let index = 0; index < 3000; index++) message.run(`history-${index}`, channelId, index % 2 ? 'agent' : 'ceo', `作者${index % 7}`,
        `历史消息 ${index}\n` + '可复现的长短混合内容。'.repeat(index % 11 * 18 + 1), 'completed', new Date(1700000000000 + index * 1000).toISOString(), index % 2 ? modelId : null)
      const run = database.prepare('INSERT INTO task_runs(id,channel_id,model_config_id,status,created_at) VALUES(?,?,?,?,?)')
      const event = database.prepare('INSERT INTO task_run_events(id,task_run_id,seq,generation,event_type,metadata_json,display_reason,created_at) VALUES(?,?,?,?,?,?,?,?)')
      for (let index = 0; index < 300; index++) {
        run.run(`history-run-${index}`, channelId, modelId, 'completed', new Date(1700000000000 + index * 1000).toISOString())
        for (let seq = 1; seq <= 3; seq++) event.run(`history-event-${index}-${seq}`, `history-run-${index}`, seq, 0, 'model_attempt', '{}', `历史尝试 ${index}-${seq}`, new Date(1700000000000 + index * 1000).toISOString())
      }
    })()
  } finally { database.close() }
}

test('measures reproducible mixed-height durable history and status rows', async ({ desktop, provider }) => {
  await createProject(desktop)
  await configureModel(desktop.page, provider.url)
  await seedHistory(desktop)
  const began = Date.now()
  await desktop.page.reload()
  await expect(desktop.page.locator('[data-history-row="message:history-2999"]')).toBeVisible()
  const stats = await desktop.page.getByRole('log', { name: '群聊消息', exact: true }).evaluate((element) => ({
    articles: element.querySelectorAll('article.message').length,
    events: element.querySelectorAll('.model-attempt').length,
    statuses: element.querySelectorAll('.run-status').length,
    nodes: element.querySelectorAll('*').length,
    scrollHeight: element.scrollHeight,
    viewportHeight: element.clientHeight,
    mountedRows: element.querySelectorAll('[data-history-row]').length,
  }))
  console.log('HISTORY_MEASUREMENT', JSON.stringify({ ...stats, reloadToReadyMs: Date.now() - began }))
  expect(provider.requests).toHaveLength(0)
  expect(stats.mountedRows).toBeLessThanOrEqual(80)
  expect(stats.nodes).toBeLessThan(600)
  const persisted = await desktop.page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    const snapshot = await window.agentTeam.tasks.snapshot(channel.id)
    return { messages: snapshot.messages.length, events: snapshot.events.length, runs: snapshot.runs.length }
  })
  expect(persisted).toEqual({ messages: 3000, events: 900, runs: 300 })
  await desktop.page.getByRole('button', { name: '最早记录', exact: true }).click()
  await expect(desktop.page.locator('[data-history-row="message:history-0"]')).toContainText('历史消息 0')
  await expect(desktop.page.getByRole('log', { name: '群聊消息', exact: true })).toContainText('作者1')
  await expect(desktop.page.locator('[data-history-row="message:history-1"]')).toContainText('实际完成模型配置')
  await desktop.page.screenshot({ path: 'test-results/v05-history-earliest.png', fullPage: true })
  const reading = await desktop.page.getByRole('log', { name: '群聊消息', exact: true }).evaluate((element) => {
    element.scrollTop = 700
    element.dispatchEvent(new Event('scroll'))
    return element.scrollTop
  })
  expect(reading).toBe(700)
  await expect.poll(async () => desktop.page.locator('[data-history-row]').count()).toBeLessThanOrEqual(80)
  await desktop.page.getByRole('button', { name: '最新记录', exact: true }).click()
  await expect(desktop.page.locator('[data-history-row="message:history-2999"]')).toBeVisible()
  // Navigate to the middle through the native scrollbar; all rows remain reachable.
  await desktop.page.getByRole('log', { name: '群聊消息', exact: true }).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(async () => desktop.page.locator('article.message').count()).toBeGreaterThan(0)
  await desktop.page.screenshot({ path: 'test-results/v05-history-middle.png', fullPage: true })
})

test('long-history first token is visible and reading anchor survives streaming, terminal and channel switches', async ({ desktop, provider }) => {
  const { page } = desktop
  await createProject(desktop)
  await configureModel(page, provider.url)
  await seedHistory(desktop)
  await page.reload()
  await expect(page.locator('[data-history-row="message:history-2999"]')).toBeVisible()
  await sendWithConsent(page, '长会话首片与滚动锚点验证')
  await expect.poll(() => provider.requests.length).toBe(1)
  const firstTokenBegan = Date.now()
  provider.delta('FIRST_VISIBLE_TOKEN')
  const token = page.getByRole('log', { name: '群聊消息', exact: true }).getByText('FIRST_VISIBLE_TOKEN', { exact: true })
  await expect(token).toBeVisible()
  expect(await token.evaluate((element) => {
    const outer = element.closest('[role="log"]')!.getBoundingClientRect()
    const row = element.getBoundingClientRect()
    return row.top < outer.bottom && row.bottom > outer.top
  })).toBe(true)
  console.log('HISTORY_STREAM_MEASUREMENT', JSON.stringify({ firstTokenVisibleMs: Date.now() - firstTokenBegan, mountedRows: await page.locator('[data-history-row]').count() }))
  await page.getByRole('button', { name: '最早记录', exact: true }).click()
  const log = page.getByRole('log', { name: '群聊消息', exact: true })
  await log.evaluate((element) => { element.scrollTop = 700; element.dispatchEvent(new Event('scroll')) })
  await expect(page.locator('[data-history-row="message:history-2"]')).toBeAttached()
  const readAnchor = () => log.evaluate((element) => {
    const top = element.getBoundingClientRect().top + parseFloat(getComputedStyle(element).paddingTop)
    const row = [...element.querySelectorAll<HTMLElement>('[data-history-row]')].find((item) => item.getBoundingClientRect().bottom > top)!
    return { id: row.dataset.historyRow, offset: row.getBoundingClientRect().top - top, scrollTop: element.scrollTop }
  })
  await page.evaluate(() => {
    const observed: string[] = []
    ;(window as unknown as { historyTestEvents: string[] }).historyTestEvents = observed
    window.agentTeam.events.onStream((event) => { if (event.type === 'delta') observed.push(event.content ?? '') })
  })
  const anchor = await readAnchor()
  provider.delta('\n阅读历史时追加\n' + '较长流式内容。'.repeat(80))
  await expect.poll(() => page.evaluate(() => (window as unknown as { historyTestEvents: string[] }).historyTestEvents.some((content) => content.includes('阅读历史时追加')))).toBe(true)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect.poll(async () => (await readAnchor()).id).toBe(anchor.id)
  expect(Math.abs((await readAnchor()).offset - anchor.offset)).toBeLessThanOrEqual(1)
  provider.complete()
  await expect.poll(async () => page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [channel] = await window.agentTeam.channels.list(project.id)
    return (await window.agentTeam.tasks.list(channel.id)).at(-1)?.status
  })).toBe('completed')
  await expect(page.getByText('会话记录 · 3002 条消息', { exact: true })).toBeVisible()
  expect((await readAnchor()).id).toBe(anchor.id)
  expect(Math.abs((await readAnchor()).offset - anchor.offset)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '最新记录', exact: true }).click()
  await expect(log).toContainText('FIRST_VISIBLE_TOKEN')
  expect(await log.locator('.message-bubble').filter({ hasText: 'FIRST_VISIBLE_TOKEN' }).count()).toBe(1)
  await expect(log.locator('[data-history-row]')).not.toHaveCount(0)
  expect(await log.locator('[data-history-row]').count()).toBeLessThanOrEqual(80)
  await page.screenshot({ path: 'test-results/v05-history-stream-completed.png', fullPage: true })
  await page.getByLabel('界面主题', { exact: true }).selectOption('dark')
  await page.screenshot({ path: 'test-results/v05-history-stream-dark.png', fullPage: true })
  await page.setViewportSize({ width: 1440, height: 700 })
  await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(80)
  await page.getByRole('button', { name: '最早记录', exact: true }).click()
  const resizedAnchor = await readAnchor()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => (await readAnchor()).id).toBe(resizedAnchor.id)
  expect(Math.abs((await readAnchor()).offset - resizedAnchor.offset)).toBeLessThanOrEqual(1)
  const ids = await page.evaluate(async () => {
    const [project] = await window.agentTeam.projects.list()
    const [original] = await window.agentTeam.channels.list(project.id)
    const other = await window.agentTeam.channels.create({ projectId: project.id, name: '短历史频道' })
    return { original: original.id, other: other.id }
  })
  await page.reload()
  await page.getByRole('button', { name: '短历史频道', exact: true }).click()
  await expect(log).toContainText('从一个具体问题开始')
  await expect(log.locator('[data-history-row]')).toHaveCount(0)
  await page.getByRole('button', { name: '主线任务协同群', exact: true }).click()
  await expect(log).toContainText('FIRST_VISIBLE_TOKEN')
  expect(ids.original).not.toBe(ids.other)
  await page.getByLabel('消息内容', { exact: true }).fill('终止并拒绝迟到流')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => provider.requests.length).toBe(2)
  provider.delta('取消前的片段')
  await expect(log).toContainText('取消前的片段')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect.poll(async () => page.evaluate(async (channelId) => (await window.agentTeam.tasks.list(channelId)).at(-1)?.status, ids.original)).toBe('cancelled')
  await expect(log).not.toContainText('取消前的片段')
  await page.evaluate(async (channelId) => {
    const run = (await window.agentTeam.tasks.list(channelId)).at(-1)!
    // Deliver through the actual preload event subscription from Main below.
    return { id: run.id, generation: run.generation - 1 }
  }, ids.original).then(async (run) => desktop.app.evaluate(({ BrowserWindow }, old) => {
    BrowserWindow.getAllWindows()[0].webContents.send('message:stream', { taskRunId: old.id, generation: old.generation, type: 'delta', content: 'LATE_STALE_TOKEN' })
  }, run))
  await expect(log).not.toContainText('LATE_STALE_TOKEN')
  expect(provider.requests).toHaveLength(2)
})
