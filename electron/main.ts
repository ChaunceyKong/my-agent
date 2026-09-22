import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { createTaskRunService } from './core/task-run-service'
import { createCloudConsentService } from './core/cloud-consent-service'
import { createModelClient } from './core/model-client'
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
    prepare: (database) => createTaskRunService(createRepositories(database)).recoverInterruptedTaskRuns(),
    showError: (options) => dialog.showMessageBox(options),
    quit: () => app.quit(),
  })
  if (!database) return
  app.once('will-quit', () => database.close())
  const repositories = createRepositories(database)
  const taskRuns = createTaskRunService(repositories)
  const consent = createCloudConsentService(repositories)
  const modelClient = createModelClient({
    repositories,
    consent,
    taskRuns,
    crypto: safeStorage,
  })
  registerHandlers({
    ipcMain,
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options as OpenDialogOptions) },
    repositories,
    taskRuns,
    modelClient,
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
