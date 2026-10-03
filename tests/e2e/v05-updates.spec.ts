import { test, expect, configureModel, createProject, sendWithConsent } from './fixtures'

test('real Main updater remains unavailable and narrow in development, with light/dark guidance', async ({ desktop }) => {
  const { page, app } = desktop
  await app.evaluate(({ session }) => {
    ;(globalThis as unknown as { updateRequests: string[] }).updateRequests = []
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      ;(globalThis as unknown as { updateRequests: string[] }).updateRequests.push(details.url)
      callback({})
    })
  })
  const responses = await page.evaluate(async () => {
    const updates = window.agentTeam.updates
    let rejected = 0
    for (const action of Object.values(updates)) {
      try { await (action as (...args: unknown[]) => Promise<unknown>)({ feed: 'https://PRIVATE.invalid', path: 'PRIVATE' }) } catch { rejected++ }
    }
    return { keys: Object.keys(updates), rejected, states: await Promise.all([updates.status(), updates.check(), updates.download(), updates.install(), updates.cancel()]) }
  })
  expect(responses.keys).toEqual(['status', 'check', 'download', 'install', 'cancel'])
  expect(responses.rejected).toBe(5)
  expect(responses.states).toEqual(Array(5).fill({ state: 'disabled', reason: 'development', progress: null, cancellable: false }))
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  const updates = page.getByRole('region', { name: '应用更新' })
  await expect(updates).toContainText('开发')
  await expect(updates.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled()
  await expect(updates.getByRole('button', { name: '下载更新', exact: true })).toBeDisabled()
  await expect(updates.getByRole('button', { name: '重启并安装更新', exact: true })).toBeDisabled()
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption(theme)
    await page.getByRole('button', { name: '模型设置', exact: true }).click()
    await updates.scrollIntoViewIfNeeded()
    await expect(updates).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: `test-results/v05-updates-${theme}.png`, fullPage: true })
  }
  expect(await app.evaluate(() => (globalThis as unknown as { updateRequests: string[] }).updateRequests)).toEqual([])
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE')
})

test('disabled updates do not block normal model settings or task dispatch', async ({ desktop, provider }) => {
  const { page } = desktop
  await createProject(desktop)
  await configureModel(page, provider.url)
  expect((await page.evaluate(() => window.agentTeam.updates.check())).state).toBe('disabled')
  await sendWithConsent(page, '更新不可用仍可工作')
  await expect.poll(() => provider.requests.length).toBe(1)
  provider.delta('正常工作'); provider.complete()
  await expect(page.getByRole('article').filter({ hasText: '正常工作' })).toBeVisible()
})
