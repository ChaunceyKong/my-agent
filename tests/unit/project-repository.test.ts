import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'
import { registerHandlers } from '../../electron/ipc/register-handlers'
import { IpcChannel } from '../../shared/ipc-channels'

let database: DatabaseClient
let repositories: Repositories
let fixtureRoot: string
let testDirectory: string

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'agent-team-database-'))
  fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-team-workspace-'))
  database = createDatabase({ filePath: join(testDirectory, 'agent-team.sqlite') })
  repositories = createRepositories(database)
})

afterEach(async () => {
  database.close()
  await Promise.all([
    rm(testDirectory, { force: true, recursive: true }),
    rm(fixtureRoot, { force: true, recursive: true }),
  ])
})

describe('project and channel repositories', () => {
  it('creates exactly one initial channel in a project', async () => {
    const { project, channel } = await repositories.createProjectWithInitialChannel({
      name: '测试项目',
      icon: '📁',
      workspacePath: await realpath(fixtureRoot),
      firstChannelName: '主线任务协同群',
    })

    expect(channel.projectId).toBe(project.id)
    expect(await repositories.listChannels(project.id)).toHaveLength(1)
    expect((await repositories.listProjects())[0]).toMatchObject({
      id: project.id,
      workspacePath: await realpath(fixtureRoot),
    })
  })

  it('lists channels only for their project', async () => {
    const first = await repositories.createProjectWithInitialChannel({
      name: '第一个项目',
      workspacePath: await realpath(fixtureRoot),
      firstChannelName: '第一个频道',
    })
    const second = await repositories.createProjectWithInitialChannel({
      name: '第二个项目',
      workspacePath: await realpath(fixtureRoot),
      firstChannelName: '第二个频道',
    })

    expect((await repositories.listChannels(first.project.id)).map((channel) => channel.name)).toEqual(['第一个频道'])
    expect((await repositories.listChannels(second.project.id)).map((channel) => channel.name)).toEqual(['第二个频道'])
  })

  it('uses the directory picker only when project creation requests browsing', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: [fixtureRoot],
    })
    registerHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog },
      repositories,
    })

    const createProject = handlers.get(IpcChannel.ProjectCreate)
    const createdWithoutBrowsing = await createProject?.(undefined, {
      name: '手动路径项目',
      workspacePath: fixtureRoot,
      firstChannelName: '手动频道',
    })
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(createdWithoutBrowsing).toMatchObject({ workspacePath: await realpath(fixtureRoot) })

    const createdWithBrowsing = await createProject?.(undefined, {
      name: '目录选择项目',
      browseForWorkspace: true,
      workspacePath: 'Z:/does-not-exist',
      firstChannelName: '选择频道',
    })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(createdWithBrowsing).toMatchObject({ workspacePath: await realpath(fixtureRoot) })
  })

  it('persists a channel created through the IPC handler', async () => {
    const { project } = await repositories.createProjectWithInitialChannel({
      name: '项目',
      workspacePath: await realpath(fixtureRoot),
      firstChannelName: '初始频道',
    })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: vi.fn() },
      repositories,
    })

    await handlers.get(IpcChannel.ChannelCreate)?.(undefined, {
      projectId: project.id,
      name: '新增频道',
      icon: '💬',
    })

    const persistedChannels = await handlers.get(IpcChannel.ChannelList)?.(undefined, project.id)
    expect(persistedChannels).toEqual([
      expect.objectContaining({ name: '初始频道', projectId: project.id }),
      expect.objectContaining({ name: '新增频道', icon: '💬', projectId: project.id }),
    ])
  })
})
