import { randomUUID } from 'node:crypto'
import type { TaskRunEvent, TaskRunEventType } from '../../shared/types'

export type EventMetadata = {
  reason?: 'restart_recovery' | 'migration_duplicate_running' | 'manual_selection' | 'automatic_selection' | 'automatic_complete' | 'cancelled' | 'completed'
  ordinal?: number
}

/** Event metadata is deliberately structured; message, file, tool and secret bodies stay in their source records. */
export function makeTaskRunEvent(input: Omit<TaskRunEvent, 'id' | 'metadataJson' | 'createdAt'> & { metadata?: EventMetadata }): TaskRunEvent {
  const metadata = input.metadata ?? {}
  if (Object.keys(metadata).some((key) => !['reason', 'ordinal'].includes(key))) throw new Error('Invalid event metadata')
  if (metadata.reason && !['restart_recovery', 'migration_duplicate_running', 'manual_selection', 'automatic_selection', 'automatic_complete', 'cancelled', 'completed'].includes(metadata.reason)) throw new Error('Invalid event reason')
  if (metadata.ordinal !== undefined && (!Number.isSafeInteger(metadata.ordinal) || metadata.ordinal < 1)) throw new Error('Invalid event ordinal')
  const eventType: TaskRunEventType = input.eventType
  return {
    id: randomUUID(), taskRunId: input.taskRunId, seq: input.seq, generation: input.generation,
    eventType, agentId: input.agentId, messageId: input.messageId, toolExecutionId: input.toolExecutionId,
    metadataJson: JSON.stringify(metadata), createdAt: new Date().toISOString(),
  }
}
