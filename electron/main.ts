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
import { openStartupDatabase } from './core/startup'
import { createDatabase } from './database/client'
import { createRepositories } from './database/repositories'
import { registerHandlers } from './ipc/register-handlers'

// Honor Chromium's profile switch before opening SQLite or encrypted credentials.
const userDataPath = app.commandLine.getSwitchValue('user-data-dir')
if (userDataPath) app.setPath('userData', userDataPath)

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/preload.js'),
    },
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
  })
  const tools = createToolEngine(repositories, approvals)
  const runner = createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine: tools })
  registerHandlers({
    ipcMain,
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options as OpenDialogOptions) },
    repositories,
    taskRuns,
    modelClient,
    approvals,
    processes,
    runner,
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
