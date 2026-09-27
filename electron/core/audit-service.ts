import { createHash, randomUUID } from 'node:crypto'
import type { AuditEvent, ToolExecution } from '../../shared/types'

export function hashToolRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Explicit allowlist: never serialize inputJson, policy, errors, or tool result bodies.
export function toolAuditEvent(channelId: string, execution: ToolExecution): AuditEvent {
  return {
    id: randomUUID(), channelId, taskRunId: execution.taskRunId,
    eventType: `tool_${execution.status}`,
    metadataJson: JSON.stringify({
      toolExecutionId: execution.id, toolName: execution.toolName, generation: execution.generation,
      riskLevel: execution.riskLevel, requestHash: execution.requestHash,
      status: execution.status, summary: execution.resultSummary,
    }),
    createdAt: execution.updatedAt,
  }
}
