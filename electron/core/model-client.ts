import type {
  ModelConfigSummary,
  ModelProviderPreset,
  SaveModelConfigInput,
  StreamChatInput,
  StreamEvent,
} from '../../shared/types'
import type { ModelConfigRecord, Repositories } from '../database/repositories'
import type { CloudConsentService } from './cloud-consent-service'
import type { TaskRunService } from './task-run-service'

const DEFAULT_BASE_URL: Record<ModelProviderPreset, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
}

const MODEL_ERROR_MESSAGES = {
  network: '模型网络请求失败，请稍后重试',
  http: '模型服务请求失败，请检查配置后重试',
  malformed: '模型响应格式异常，请稍后重试',
  provider: '模型服务返回错误，请稍后重试',
  cancelled: '模型请求已取消',
  credential: 'API 密钥不能包含换行符',
} as const

class ModelClientError extends Error {
  constructor(readonly category: keyof typeof MODEL_ERROR_MESSAGES) {
    super(MODEL_ERROR_MESSAGES[category])
  }
}

export interface CryptoAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface ModelClient {
  saveModelConfig(input: SaveModelConfigInput): Promise<ModelConfigSummary>
  listModelConfigs(): Promise<ModelConfigSummary[]>
  recordCloudConsent(projectId: string, modelConfigId: string): Promise<void>
  requireCloudConsent(projectId: string, modelConfigId: string): Promise<void>
  streamChat(input: StreamChatInput, onEvent: (event: StreamEvent) => void | Promise<void>, canSend?: () => Promise<boolean>): Promise<void>
}

export interface ModelClientDependencies {
  repositories: Repositories
  consent: CloudConsentService
  taskRuns: Pick<TaskRunService, 'canAcceptChunk' | 'onCancelled'>
  crypto: CryptoAdapter
  fetch?: typeof globalThis.fetch
}

export function createModelClient({
  repositories,
  consent,
  taskRuns,
  crypto,
  fetch: fetchImpl = globalThis.fetch,
}: ModelClientDependencies): ModelClient {
  return {
    async saveModelConfig(input: SaveModelConfigInput): Promise<ModelConfigSummary> {
      validateApiKey(input.apiKey)
      if (!crypto.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
      const baseUrl = normalizeBaseUrl(input.baseUrl || DEFAULT_BASE_URL[input.providerPreset])
      const encryptedApiKey = crypto.encryptString(input.apiKey).toString('base64')
      const saved = await repositories.saveModelConfig({
        providerPreset: input.providerPreset,
        baseUrl,
        modelName: input.modelName,
        encryptedApiKey,
      })
      return summarize(saved)
    },

    async listModelConfigs(): Promise<ModelConfigSummary[]> {
      return (await repositories.listModelConfigs()).map(summarize)
    },

    recordCloudConsent: (projectId, modelConfigId) => consent.recordCloudConsent(projectId, modelConfigId),
    requireCloudConsent: (projectId, modelConfigId) => consent.requireCloudConsent(projectId, modelConfigId),

    async streamChat(input: StreamChatInput, onEvent: (event: StreamEvent) => void | Promise<void>, canSend?: () => Promise<boolean>): Promise<void> {
      const controller = new AbortController()
      const unsubscribe = taskRuns.onCancelled(input.taskRunId, () => controller.abort())
      try {
        if (!await taskRuns.canAcceptChunk(input.taskRunId)) return
        await consent.requireCloudConsent(input.projectId, input.modelConfigId)
        const modelConfig = await repositories.getModelConfig(input.modelConfigId)
        if (!modelConfig) throw new Error('Model configuration not found')
        if (canSend && !await canSend()) return

        try {
          controller.signal.throwIfAborted()
          const apiKey = crypto.decryptString(Buffer.from(modelConfig.encryptedApiKey, 'base64'))
          validateApiKey(apiKey)
          const response = await fetchImpl(`${normalizeBaseUrl(modelConfig.baseUrl)}/chat/completions`, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: modelConfig.modelName,
              messages: input.messages,
              ...(input.tools?.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
              stream: true,
            }),
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw new ModelClientError('http')
          }
          if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
            await response.body?.cancel()
            throw new ModelClientError('malformed')
          }
          await consumeEventStream(response.body, input.taskRunId, taskRuns, onEvent, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) return
          await emitIfAccepted(taskRuns, input.taskRunId, onEvent, {
            taskRunId: input.taskRunId,
            type: 'error',
            content: MODEL_ERROR_MESSAGES[error instanceof ModelClientError
              ? error.category
              : error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'network'],
          })
        }
      } finally {
        unsubscribe()
      }
    },
  }
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  taskRunId: string,
  taskRuns: { canAcceptChunk(id: string): Promise<boolean> },
  onEvent: (event: StreamEvent) => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let hasData = false
  const pendingToolCalls = new Map<number, StreamEvent['toolCall']>()
  let toolCallsTerminal = false
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })

  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        const data = block.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') {
          if (!hasData) throw new ModelClientError('malformed')
          if ((pendingToolCalls.size && !toolCallsTerminal) || (toolCallsTerminal && pendingToolCalls.size === 0)) throw new ModelClientError('malformed')
          for (const call of pendingToolCalls.values()) await emitIfAccepted(taskRuns, taskRunId, onEvent, { taskRunId, type: 'tool_call', toolCall: call })
          await emitIfAccepted(taskRuns, taskRunId, onEvent, { taskRunId, type: 'complete' })
          return
        }
        if (toolCallsTerminal) throw new ModelClientError('malformed')
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data)
          if (!isRecord(parsed)) throw new ModelClientError('malformed')
        } catch {
          throw new ModelClientError('malformed')
        }
        if (parsed.error) throw new ModelClientError('provider')
        if (!Array.isArray(parsed.choices)) throw new ModelClientError('malformed')
        // OpenAI-compatible streams may end with a usage-only chunk.
        if (parsed.choices.length === 0) {
          if (!hasData || !isRecord(parsed.usage)) throw new ModelClientError('malformed')
          continue
        }
        for (const choice of parsed.choices) {
          if (!isRecord(choice) || !isRecord(choice.delta)
            || (choice.delta.content != null && typeof choice.delta.content !== 'string')
            || (choice.delta.tool_calls != null && !Array.isArray(choice.delta.tool_calls))
            || (choice.finish_reason != null && typeof choice.finish_reason !== 'string')) {
            throw new ModelClientError('malformed')
          }
        }
        hasData = true
        const content = parsed.choices[0].delta.content
        if (typeof content === 'string' && content.length > 0) {
          const accepted = await emitIfAccepted(taskRuns, taskRunId, onEvent, { taskRunId, type: 'delta', content })
          if (!accepted) return
        }
        const choice = parsed.choices[0]
        const calls = choice.delta.tool_calls
        if (calls !== undefined) for (const call of calls) {
          if (!isRecord(call) || !Number.isInteger(call.index) || (call.index as number) < 0 || !isRecord(call.function)
            || (call.id !== undefined && typeof call.id !== 'string') || (call.function.name !== undefined && typeof call.function.name !== 'string')
            || (call.function.arguments !== undefined && typeof call.function.arguments !== 'string')) throw new ModelClientError('malformed')
          const index = call.index as number
          const prior = pendingToolCalls.get(index)
          if (prior && ((call.id && prior.id && call.id !== prior.id) || (call.function.name && prior.name && call.function.name !== prior.name))) throw new ModelClientError('malformed')
          pendingToolCalls.set(index, { index, id: call.id ?? prior?.id ?? '', name: (call.function.name ?? prior?.name ?? '') as any, arguments: (prior?.arguments ?? '') + (call.function.arguments ?? '') })
        }
        if (choice.finish_reason === 'tool_calls') toolCallsTerminal = true
        else if (choice.finish_reason !== null && pendingToolCalls.size) throw new ModelClientError('malformed')
      }

      if (done) throw new ModelClientError('malformed')
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function emitIfAccepted(
  taskRuns: { canAcceptChunk(id: string): Promise<boolean> },
  taskRunId: string,
  onEvent: (event: StreamEvent) => void | Promise<void>,
  event: StreamEvent,
): Promise<boolean> {
  if (!await taskRuns.canAcceptChunk(taskRunId)) return false
  await onEvent(event)
  return true
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function validateApiKey(apiKey: string): void {
  if (/[\r\n]/.test(apiKey)) throw new ModelClientError('credential')
}

function summarize(config: ModelConfigRecord): ModelConfigSummary {
  return {
    id: config.id,
    providerPreset: config.providerPreset,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    hasApiKey: config.encryptedApiKey.length > 0,
  }
}
