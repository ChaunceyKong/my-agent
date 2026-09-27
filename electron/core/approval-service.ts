import type { ApprovalRequest } from '../../shared/types'
import type { Repositories } from '../database/repositories'

const FIVE_MINUTES = 5 * 60 * 1000

export function createApprovalService(repositories: Repositories, clock: () => Date = () => new Date()) {
  return {
    request(toolExecutionId: string): Promise<ApprovalRequest> {
      return repositories.createApprovalRequest(toolExecutionId, new Date(clock().getTime() + FIVE_MINUTES).toISOString())
    },
    approve(id: string, requestHash: string): Promise<ApprovalRequest> {
      return repositories.decideApprovalRequest(id, requestHash, 'approved', clock().toISOString())
    },
    reject(id: string, requestHash: string): Promise<ApprovalRequest> {
      return repositories.decideApprovalRequest(id, requestHash, 'rejected', clock().toISOString())
    },
    expire(id: string): Promise<ApprovalRequest> {
      return repositories.expireApprovalRequest(id, clock().toISOString())
    },
  }
}
