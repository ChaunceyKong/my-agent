import type { Repositories } from '../database/repositories'
import type { ModelSelection } from './model-client'

/** Main-only route fence: an intermediate fallback edit also invalidates a call. */
export async function captureModelRoute(repositories: Repositories, configuredModelConfigId: string) {
  const configs = await repositories.getModelFallbackChain(configuredModelConfigId)
  const snapshot = JSON.stringify(configs)
  return {
    configured: configs[0],
    snapshot,
    includes(selection: ModelSelection) {
      return selection.configuredModelConfigId === configuredModelConfigId
        && configs.some((config) => config.id === selection.actualModelConfigId && JSON.stringify(config) === selection.modelSnapshot)
    },
    async current() { return JSON.stringify(await repositories.getModelFallbackChain(configuredModelConfigId)) === snapshot },
  }
}
