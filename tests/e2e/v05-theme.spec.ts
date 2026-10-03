import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Locator } from 'playwright/test'
import { test, expect, createProject } from './fixtures'

async function expectReadablePlaceholder(field: Locator, theme: 'light' | 'dark') {
  const colors = await field.evaluate((element) => {
    const placeholder = getComputedStyle(element, '::placeholder')
    const background = getComputedStyle(element).backgroundColor
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number)
    const bg = rgb(background)
    const opacity = Number(placeholder.opacity)
    const fg = rgb(placeholder.color).map((channel, index) => channel * opacity + bg[index] * (1 - opacity))
    const luminance = (channels: number[]) => channels.map((channel) => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0)
    const light = Math.max(luminance(fg), luminance(bg))
    const dark = Math.min(luminance(fg), luminance(bg))
    return { foreground: placeholder.color, background, opacity, contrast: (light + .05) / (dark + .05) }
  })
  expect(colors.foreground).toBe(theme === 'dark' ? 'rgb(167, 179, 199)' : 'rgb(98, 110, 131)')
  expect(colors.opacity).toBe(1)
  expect(colors.contrast, JSON.stringify(colors)).toBeGreaterThanOrEqual(4.5)
}

test('system is the default and follows live system color changes without a project', async ({ desktop }) => {
  const { page } = desktop
  const selector = page.getByRole('combobox', { name: '界面主题', exact: true })
  await expect(selector).toHaveValue('system')
  await expect(page.getByRole('heading', { name: '主线任务协同群', exact: true })).toHaveCount(0)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: 'test-results/v05-theme-system-dark.png', fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.screenshot({ path: 'test-results/v05-theme-system-light.png', fullPage: true })
  await expect(selector).toHaveValue('system')
})

test('explicit themes and returning to system survive real Electron restarts', async ({ desktop }) => {
  for (const theme of ['dark', 'light'] as const) {
    const page = desktop.page
    await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption(theme)
    await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    expect(await page.evaluate(() => localStorage.getItem('agent-team-theme'))).toBe(theme)
    await desktop.restart()
    await expect(desktop.page.getByRole('combobox', { name: '界面主题', exact: true })).toHaveValue(theme)
    await expect(desktop.page.locator('html')).toHaveAttribute('data-theme', theme)
  }
  await desktop.page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('system')
  expect(await desktop.page.evaluate(() => localStorage.getItem('agent-team-theme'))).toBe('system')
  await desktop.restart()
  await expect(desktop.page.getByRole('combobox', { name: '界面主题', exact: true })).toHaveValue('system')
  await desktop.page.emulateMedia({ colorScheme: 'dark' })
  await expect(desktop.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await desktop.page.emulateMedia({ colorScheme: 'light' })
  await expect(desktop.page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('invalid persisted preference falls back to the system on startup', async ({ desktop }) => {
  await desktop.page.evaluate(() => localStorage.setItem('agent-team-theme', 'unexpected-theme'))
  await desktop.restart()
  await expect(desktop.page.getByRole('combobox', { name: '界面主题', exact: true })).toHaveValue('system')
  await desktop.page.emulateMedia({ colorScheme: 'dark' })
  await expect(desktop.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await desktop.page.emulateMedia({ colorScheme: 'light' })
  await expect(desktop.page.locator('html')).toHaveAttribute('data-theme', 'light')
})

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} settings and template preview remain usable and produce visual evidence`, async ({ desktop }) => {
    const { page } = desktop
    await mkdir(resolve('test-results'), { recursive: true })
    await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption(theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.getByRole('button', { name: '模型设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '模型设置', exact: true })
    await expect(settings.getByLabel('模型名称', { exact: true })).toBeVisible()
    await expect(settings.getByRole('combobox', { name: '备选模型', exact: true })).toBeVisible()
    await expectReadablePlaceholder(settings.getByLabel('最大输出 Token', { exact: true }), theme)
    await page.screenshot({ path: resolve(`test-results/v05-theme-${theme}-settings.png`) })
    // Invalid budgets are rejected by Main before any Provider request.
    await settings.getByLabel('API Key', { exact: true }).fill('theme-validation-only-key')
    await settings.getByLabel('上下文窗口', { exact: true }).fill('1')
    await settings.getByRole('button', { name: '保存配置', exact: true }).click()
    await expect(settings.getByRole('status')).toHaveText('模型上下文窗口无效')
    await settings.getByLabel('API Key', { exact: true }).fill('')
    await expect(settings.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled()
    await settings.getByLabel('上下文窗口', { exact: true }).focus()
    await expect(settings.getByLabel('上下文窗口', { exact: true })).toBeFocused()
    await page.screenshot({ path: resolve(`test-results/v05-theme-${theme}-validation-focus.png`) })
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await createProject(desktop)
    await expectReadablePlaceholder(page.getByLabel('消息内容', { exact: true }), theme)
    await page.getByRole('tab', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: '预览模板：自媒体与内容矩阵运营', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '模板预览：自媒体与内容矩阵运营', exact: true })
    await expect(preview.locator('.template-prompt').first()).toBeVisible()
    await expect(preview.getByRole('button', { name: '复制并编辑：内容主编 (PM)', exact: true })).toBeVisible()
    await page.screenshot({ path: resolve(`test-results/v05-theme-${theme}-template.png`) })
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await expect(preview).toHaveCount(0)
  })
}
