import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { Channel, CreateChannelInput, CreateProjectInput, Project } from '../../shared/types'
import type { DatabaseClient } from './client'
import { channels, projects } from './schema'

export interface Repositories {
  listProjects(): Promise<Project[]>
  createProjectWithInitialChannel(input: CreateProjectInput): Promise<{ project: Project; channel: Channel }>
  listChannels(projectId: string): Promise<Channel[]>
  createChannel(input: CreateChannelInput): Promise<Channel>
}

export function createRepositories(client: DatabaseClient): Repositories {
  return {
    async listProjects(): Promise<Project[]> {
      return client.db.select().from(projects).orderBy(asc(projects.createdAt), asc(projects.id)).all()
    },

    async createProjectWithInitialChannel(input: CreateProjectInput): Promise<{ project: Project; channel: Channel }> {
      const timestamp = new Date().toISOString()
      const project: Project = {
        id: randomUUID(),
        name: input.name,
        icon: input.icon ?? null,
        workspacePath: input.workspacePath,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const channel: Channel = {
        id: randomUUID(),
        projectId: project.id,
        name: input.firstChannelName ?? '主线任务协同群',
        icon: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      client.db.transaction((tx) => {
        tx.insert(projects).values(project).run()
        tx.insert(channels).values(channel).run()
      })

      return { project, channel }
    },

    async listChannels(projectId: string): Promise<Channel[]> {
      return client.db.select().from(channels)
        .where(eq(channels.projectId, projectId))
        .orderBy(asc(channels.createdAt), asc(channels.id))
        .all()
    },

    async createChannel(input: CreateChannelInput): Promise<Channel> {
      const timestamp = new Date().toISOString()
      const channel: Channel = {
        id: randomUUID(),
        projectId: input.projectId,
        name: input.name,
        icon: input.icon ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      client.db.insert(channels).values(channel).run()
      return channel
    },
  }
}
