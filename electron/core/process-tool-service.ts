import type { Repositories } from '../database/repositories'
import type { TaskRunService } from './task-run-service'
import { executeRegisteredProcess } from './process-tool'
import { createApprovedOverwriteService } from './approved-overwrite-service'

export function createProcessToolService(repositories: Repositories, taskRuns: TaskRunService, clock: () => Date = () => new Date()) {
  const overwrites = createApprovedOverwriteService(repositories, clock)
  return {
    async runApproved(approvalId: string) {
      const approval = await repositories.getApprovalRequest(approvalId)
      if (!approval || approval.status !== 'approved') throw new Error('审批请求不可用')
      const execution = await repositories.getToolExecution(approval.toolExecutionId)
      if (execution?.toolName === 'write_file') {
        try {
          const result = await overwrites.runApproved(approvalId)
          if (result.status === 'completed' || result.status === 'failed') await finishRun(execution.taskRunId, result.resultSummary)
          return result
        } catch (error) {
          await finishRun(execution.taskRunId, '已批准操作未执行')
          throw error
        }
      }
      if (execution?.toolName !== 'run_process') throw new Error('审批请求不可用')
      const controller = new AbortController()
      const unsubscribe = taskRuns.onCancelled(execution.taskRunId, () => controller.abort())
      let claimed: Awaited<ReturnType<typeof repositories.claimApprovedProcess>> | undefined
      try {
        claimed = await repositories.claimApprovedProcess(approvalId, new Date().toISOString())
        const input = JSON.parse(claimed.execution.inputJson) as { args: string[] }
        const result = await executeRegisteredProcess({ executable: claimed.executable, args: input.args, cwd: claimed.workspacePath, signal: controller.signal })
        const completed = await repositories.finishToolExecution(claimed.execution.id, () => ({ status: result.exitCode === 0 ? 'completed' : 'failed', riskLevel: 'high',
          resultSummary: result.exitCode === null ? '进程已取消' : `进程退出码 ${result.exitCode}${result.stderr ? '; stderr 已截断' : ''}` }))
        await finishRun(claimed.execution.taskRunId, completed.resultSummary)
        return completed
      } catch {
        if (!claimed) {
          await finishRun(execution.taskRunId, '已批准操作未执行')
          throw new Error('审批请求不可用')
        }
        const failed = await repositories.finishToolExecution(claimed.execution.id, () => ({ status: 'failed', riskLevel: 'high', resultSummary: '受控进程执行失败' }))
        await finishRun(claimed.execution.taskRunId, failed.resultSummary)
        return failed
      } finally { unsubscribe() }
    },
  }

  async function finishRun(taskRunId: string, result: string | null): Promise<void> {
    // Explicit effects do not resume the model loop in v0.2. Close only a still-live
    // run; cancellation and generation changes win without being overwritten.
    await taskRuns.finishTaskRun(taskRunId, `已完成已批准操作：${result ?? '无结果'}。`).catch(() => undefined)
  }
}
