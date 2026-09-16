import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCloudConsentService, type CloudConsentService } from '../../electron/core/cloud-consent-service'
import { createDatabase, type DatabaseClient } from '../../electron/database/client'
import { createRepositories, type Repositories } from '../../electron/database/repositories'

let database: DatabaseClient
let repositories: Repositories
let consent: CloudConsentService
let testDirectory: string
let databasePath: string

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'agent-team-consent-'))
  databasePath = join(testDirectory, 'agent-team.sqlite')
  database = createDatabase({ filePath: databasePath })
  repositories = createRepositories(database)
  consent = createCloudConsentService(repositories)
})

afterEach(async () => {
  database.close()
  await rm(testDirectory, { force: true, recursive: true })
})

describe('cloud consent service', () => {
  it('rejects a cloud request without consent for the exact project and model', async () => {
    await expect(consent.requireCloudConsent('project-1', 'model-1'))
      .rejects.toThrow('Cloud consent is required')
  })

  it('persists consent only for the recorded project and model pair', async () => {
    const { project } = await repositories.createProjectWithInitialChannel({
      name: '同意测试',
      workspacePath: testDirectory,
    })
    const model = await repositories.saveModelConfig({
      providerPreset: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-test',
      encryptedApiKey: 'encrypted-secret',
    })

    await consent.recordCloudConsent(project.id, model.id)

    database.close()
    database = createDatabase({ filePath: databasePath })
    repositories = createRepositories(database)
    consent = createCloudConsentService(repositories)

    await expect(consent.requireCloudConsent(project.id, model.id)).resolves.toBeUndefined()
    await expect(consent.requireCloudConsent('another-project', model.id)).rejects.toThrow('Cloud consent is required')
    await expect(consent.requireCloudConsent(project.id, 'another-model')).rejects.toThrow('Cloud consent is required')
  })
})
