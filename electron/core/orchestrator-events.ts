import { randomUUID } from 'node:crypto'
import type { TaskRunEvent, TaskRunEventType } from '../../shared/types'

export type EventMetadata = {
  reason?: 'restart_recovery' | 'migration_duplicate_running' | 'manual_selection' | 'automatic_selection' | 'automatic_complete' | 'cancelled' | 'completed'
  ordinal?: number
  configuredModelConfigId?: string
  actualModelConfigId?: string
}

/** Event metadata is deliberately structured; message, file, tool and secret bodies stay in their source records. */
export function makeTaskRunEvent(input: Omit<TaskRunEvent, 'id' | 'metadataJson' | 'displayReason' | 'createdAt'> & { metadata?: EventMetadata; displayReason?: string }): TaskRunEvent {
  const metadata = input.metadata ?? {}
  if (Object.keys(metadata).some((key) => !['reason', 'ordinal', 'configuredModelConfigId', 'actualModelConfigId'].includes(key))) throw new Error('Invalid event metadata')
  for (const id of [metadata.configuredModelConfigId, metadata.actualModelConfigId]) {
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\p{Cc}\p{Cf}]/u.test(id))) throw new Error('Invalid model identity')
  }
  if (metadata.reason && !['restart_recovery', 'migration_duplicate_running', 'manual_selection', 'automatic_selection', 'automatic_complete', 'cancelled', 'completed'].includes(metadata.reason)) throw new Error('Invalid event reason')
  if (metadata.ordinal !== undefined && (!Number.isSafeInteger(metadata.ordinal) || metadata.ordinal < 1)) throw new Error('Invalid event ordinal')
  const eventType: TaskRunEventType = input.eventType
  if (input.displayReason !== undefined && (!['speaker_decided', 'model_attempt', 'model_switched'].includes(eventType) || input.displayReason.length < 1
    || input.displayReason.length > 200 || input.displayReason.trim() !== input.displayReason
    || /[\p{Cc}\p{Cf}]/u.test(input.displayReason))) throw new Error('Invalid display reason')
  return {
    id: randomUUID(), taskRunId: input.taskRunId, seq: input.seq, generation: input.generation,
    eventType, agentId: input.agentId, messageId: input.messageId, toolExecutionId: input.toolExecutionId,
    metadataJson: JSON.stringify(metadata), displayReason: input.displayReason ?? null, createdAt: new Date().toISOString(),
  }
}
