import type { Repositories } from '../database/repositories'

export interface CloudConsentService {
  recordCloudConsent(projectId: string, modelConfigId: string): Promise<void>
  requireCloudConsent(projectId: string, modelConfigId: string): Promise<void>
}

export function createCloudConsentService(repositories: Repositories): CloudConsentService {
  return {
    recordCloudConsent: (projectId, modelConfigId) => repositories.recordCloudConsent(projectId, modelConfigId),

    async requireCloudConsent(projectId: string, modelConfigId: string): Promise<void> {
      if (!await repositories.hasCloudConsent(projectId, modelConfigId)) {
        throw new Error('Cloud consent is required for this project and model configuration')
      }
    },
  }
}
