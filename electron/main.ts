import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { createTaskRunService } from './core/task-run-service'
import { createApprovalService } from './core/approval-service'
import { createProcessToolService } from './core/process-tool-service'
import { createApprovedOverwriteService } from './core/approved-overwrite-service'
import { createCloudConsentService } from './core/cloud-consent-service'
import { createModelClient } from './core/model-client'
import { createToolEngine } from './core/tool-engine'
import { createSingleAgentRunner } from './core/single-agent-runner'
import { createSerialOrchestrator } from './core/serial-orchestrator'
import { openStartupDatabase } from './core/startup'
import { createDatabase } from './database/client'
import { createRepositories } from './database/repositories'
import { registerHandlers } from './ipc/register-handlers'
import { createDiagnostics } from './core/diagnostics'
import { createFatalHandler } from './core/fatal-errors'

// Honor Chromium's profile switch before opening SQLite or encrypted credentials.
const userDataPath = app.commandLine.getSwitchValue('user-data-dir')
if (userDataPath) app.setPath('userData', userDataPath)

const diagnostics = createDiagnostics({
  userData: app.getPath('userData'),
  showSaveDialog: () => dialog.showSaveDialog({ title: '导出诊断日志', defaultPath: 'agent-team-diagnostics.log', filters: [{ name: '诊断日志', extensions: ['log'] }] }),
})
const fatal = createFatalHandler({
  record: (code) => diagnostics.record(code),
  showError: () => dialog.showErrorBox('工作台无法继续运行', '应用遇到意外错误，将安全退出。已有数据会保留；请重新启动并检查任务和恢复状态，不会自动重播操作。'),
  exit: () => app.exit(1),
})
process.on('uncaughtException', () => fatal('main_uncaught_exception'))
process.on('unhandledRejection', () => fatal('main_unhandled_rejection'))

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/preload.js'),
    },
  })
  window.webContents.on('render-process-gone', () => fatal('renderer_process_gone'))
  try {
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else await window.loadFile(join(__dirname, '../renderer/index.html'))
  } catch { fatal('window_load_failed') }
}

app.whenReady().then(async () => {
  const database = await openStartupDatabase({
    open: () => createDatabase({ filePath: join(app.getPath('userData'), 'agent-team.sqlite') }),
    prepare: async (database) => {
      const repositories = createRepositories(database)
      // Finish or surface a durable published replacement before interrupted runs are
      // cancelled; no new effect is started during recovery.
      await createApprovedOverwriteService(repositories).recoverInterruptedPublications()
      await createTaskRunService(repositories).recoverInterruptedTaskRuns()
    },
    showError: (options) => dialog.showMessageBox(options),
    quit: () => app.quit(),
    recordFailure: () => diagnostics.record('startup_database_failed'),
  })
  if (!database) return
  app.once('will-quit', () => database.close())
  const repositories = createRepositories(database)
  const taskRuns = createTaskRunService(repositories)
  const approvals = createApprovalService(repositories)
  const processes = createProcessToolService(repositories, taskRuns)
  const consent = createCloudConsentService(repositories)
  const modelClient = createModelClient({
    repositories,
    consent,
    taskRuns,
    crypto: safeStorage,
    recordFailure: () => diagnostics.record('model_failed'),
  })
  const tools = createToolEngine(repositories, approvals)
  const runner = createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine: tools })
  const orchestrator = createSerialOrchestrator({ repositories, modelClient, taskRuns, runner })
  registerHandlers({
    ipcMain,
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options as OpenDialogOptions) },
    repositories,
    taskRuns,
    modelClient,
    approvals,
    processes,
    runner,
    orchestrator,
    diagnostics,
  })
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(() => fatal('window_load_failed'))
  })
}).catch(() => fatal('main_startup_failed'))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
