import { test, expect, chromium, type Browser } from 'playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'

test('real portable launcher self-extracts, persists isolated SQLite/theme, and cleans its runtime on exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-team-portable-cdp-'))
  const userData = join(root, 'user-data'); const runtimeTemp = join(root, 'runtime-temp')
  await mkdir(userData); await mkdir(runtimeTemp)
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE'].includes(entry[0])))
  const executable = resolve('release/win-v0.5.1/Agent Team Desktop 0.5.1.exe')
  let launcher: ChildProcess | undefined; let browser: Browser | undefined; let exited: Promise<void> | undefined
  async function waitForExit() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exited!, new Promise<void>((_done, reject) => {
        timer = setTimeout(() => reject(new Error(`Portable wrapper did not exit; temporary directory retained: ${root}`)), 10_000)
      })])
    } finally { clearTimeout(timer) }
  }
  async function launch() {
    const server = createServer(); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
    const port = address.port; await new Promise<void>((done) => server.close(() => done()))
    // The NSIS portable wrapper does not forward Playwright's inspector stderr. Connect
    // browser CDP to the actual launcher instead; no product hook or Main observations faked.
    launcher = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { env: { ...env, TEMP: runtimeTemp, TMP: runtimeTemp }, shell: false, windowsHide: true, stdio: 'ignore' })
    exited = new Promise<void>((done, reject) => { launcher!.once('exit', (code) => code === 0 ? done() : reject(new Error(`Portable exit ${code}`))); launcher!.once('error', reject) })
    void exited.catch(() => {})
    await expect.poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok } catch { return false } }, { timeout: 25_000 }).toBe(true)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = browser.contexts()[0].pages()[0]
    await expect(page.getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    const cdp = await browser!.newBrowserCDPSession()
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    const pid = processInfo.find((info: { type: string }) => info.type === 'browser')?.id
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) throw new Error('No observed browser PID')
    const processInfoJson = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ExecutablePath,ParentProcessId | ConvertTo-Json -Compress`], { windowsHide: true, encoding: 'utf8' })
    const processEvidence = JSON.parse(processInfoJson)
    const runtimeRelative = relative(runtimeTemp, processEvidence.ExecutablePath)
    expect(isAbsolute(runtimeRelative)).toBe(false)
    expect(runtimeRelative).not.toBe('..'); expect(runtimeRelative).not.toBe('')
    expect(runtimeRelative.startsWith(`..${sep}`)).toBe(false)
    expect(processEvidence.ExecutablePath.toLowerCase()).not.toBe(executable.toLowerCase())
    await expect(page.getByText('v0.5.1', { exact: true })).toBeVisible()
    const initial = await page.evaluate(async () => ({ projects: await window.agentTeam.projects.list(), require: typeof (window as unknown as { require?: unknown }).require,
      updates: await Promise.all(Object.values(window.agentTeam.updates).map((action) => action())) }))
    expect(initial.projects).toEqual([]); expect(initial.require).toBe('undefined')
    expect(initial.updates).toEqual(Array(5).fill({ state: 'disabled', reason: 'portable', progress: null, cancellable: false }))
    // Without Main inspector/native chooser automation, portable verifies actual startup
    // schema/read and theme restart; project write persistence is proven by unpacked smoke.
    await page.getByRole('combobox', { name: '界面主题', exact: true }).selectOption('dark')
    await page.screenshot({ path: 'test-results/package-portable-dark.png', fullPage: true })
    await page.evaluate(() => window.close()); await waitForExit(); await browser!.close(); browser = undefined
    expect(await readdir(runtimeTemp)).toEqual([])
    const db = new Database(join(userData, 'agent-team.sqlite'), { readonly: true, fileMustExist: true })
    try { expect(db.pragma('user_version', { simple: true })).toBe(18); expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 }) } finally { db.close() }
    page = await launch()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await page.evaluate(() => window.agentTeam.projects.list())).toEqual([])
    console.log('PORTABLE_SMOKE', JSON.stringify({ launchedPortableExe: true, selfExtractedRuntime: true, isolatedDatabase: true, themeRestart: true, updater: 'portable-disabled', mainInspector: false, picker: 'not-tested' }))
    await page.evaluate(() => window.close()); await waitForExit(); await browser!.close(); browser = undefined
    expect(await readdir(runtimeTemp)).toEqual([])
  } finally {
    // Normal close only the browser launched by this test, then wait for its wrapper.
    if (browser) { for (const page of browser.contexts()[0].pages()) await page.evaluate(() => window.close()).catch(() => {}); await waitForExit(); await browser.close() }
    if (launcher && launcher.exitCode === null) throw new Error(`Test portable process still running; temporary directory retained: ${root}`)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
