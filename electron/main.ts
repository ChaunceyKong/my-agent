import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { createTaskRunService } from './core/task-run-service'
import { createDatabase } from './database/client'
import { createRepositories } from './database/repositories'
import { registerHandlers } from './ipc/register-handlers'

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
  const database = createDatabase({ filePath: join(app.getPath('userData'), 'agent-team.sqlite') })
  const repositories = createRepositories(database)
  const taskRuns = createTaskRunService(repositories)
  await taskRuns.recoverInterruptedTaskRuns()
  registerHandlers({
    ipcMain,
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(options as OpenDialogOptions) },
    repositories,
    taskRuns,
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
