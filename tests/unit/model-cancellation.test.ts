import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createDatabase } from '../../electron/database/client'
import { createRepositories } from '../../electron/database/repositories'
import { createTaskRunService } from '../../electron/core/task-run-service'
import { createCloudConsentService } from '../../electron/core/cloud-consent-service'
import { createModelClient } from '../../electron/core/model-client'
import type { StreamEvent } from '../../shared/types'

const databases: ReturnType<typeof createDatabase>[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })

it.each(['headers', 'data'])('cancelling while waiting for %s closes the HTTP request and allows another run', async (stage) => {
  let requests = 0
  let disconnected = false
  let streaming: Promise<void> | undefined
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* consume request before observing disconnect */ }
    requests++
    if (requests === 1) {
      response.on('close', () => { disconnected = true })
      if (stage === 'data') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
      }
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"next"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server')
    const database = createDatabase({ filePath: ':memory:' })
    databases.push(database)
    const repositories = createRepositories(database)
    const taskRuns = createTaskRunService(repositories)
    const client = createModelClient({ repositories, taskRuns, consent: createCloudConsentService(repositories),
      crypto: { isEncryptionAvailable: () => true, encryptString: Buffer.from, decryptString: (key) => key.toString() } })
    const { project, channel } = await repositories.createProjectWithInitialChannel({ name: '取消测试', workspacePath: 'test' })
    const model = await client.saveModelConfig({ providerPreset: 'openai', modelName: 'test', apiKey: 'test', baseUrl: `http://127.0.0.1:${address.port}` })
    await client.recordCloudConsent(project.id, model.id)
    const run = await taskRuns.startTaskRun(channel.id, model.id, 'first')
    const events: StreamEvent[] = []
    streaming = client.streamChat({ projectId: project.id, modelConfigId: model.id, taskRunId: run.id, messages: [] }, (event) => { events.push(event) })
    await vi.waitFor(() => expect(requests).toBe(1))
    if (stage === 'data') await vi.waitFor(() => expect(events).toHaveLength(1))
    await taskRuns.cancelTaskRun(run.id)
    await vi.waitFor(() => expect(disconnected).toBe(true))
    await streaming
    expect(events.map((event) => event.type)).toEqual(stage === 'data' ? ['delta'] : [])
    const nextRun = await taskRuns.startTaskRun(channel.id, model.id, 'next')
    const nextEvents: StreamEvent[] = []
    await client.streamChat({ projectId: project.id, modelConfigId: model.id, taskRunId: nextRun.id, messages: [] }, (event) => { nextEvents.push(event) })
    expect(nextEvents.map((event) => event.type)).toEqual(['delta', 'complete'])
    expect(requests).toBe(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await streaming
  }
})
