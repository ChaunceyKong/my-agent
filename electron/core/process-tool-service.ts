import type { Repositories } from '../database/repositories'
import type { TaskRunService } from './task-run-service'
import { executeRegisteredProcess } from './process-tool'
import { createApprovedOverwriteService } from './approved-overwrite-service'
import type { ExecutionGate } from './execution-gate'

export function createProcessToolService(repositories: Repositories, taskRuns: TaskRunService, clock: () => Date = () => new Date(), gate?: ExecutionGate) {
  const overwrites = createApprovedOverwriteService(repositories, clock, undefined, gate)
  const service = {
    async runApproved(approvalId: string) {
      const approval = await repositories.getApprovalRequest(approvalId)
      const execution = approval && await repositories.getToolExecution(approval.toolExecutionId)
      if (!execution) throw new Error('审批请求不可用')
      const result = await taskRuns.trackEffect(execution.taskRunId, () => runApprovedEffect(approvalId))
      const run = await repositories.getTaskRun(execution.taskRunId)
      if (result.resultSummary === '进程已取消' && run?.status === 'running' && run.generation === execution.generation) {
        await taskRuns.pauseTaskRun(execution.taskRunId, '受控进程调用超时，等待 CEO 处理', execution.generation)
      }
      return result
    },
  }
  if (gate) service.runApproved = gate.protect(service.runApproved)
  return service
  async function runApprovedEffect(approvalId: string) {
      const approval = await repositories.getApprovalRequest(approvalId)
      if (!approval || approval.status !== 'approved') throw new Error('审批请求不可用')
      const execution = await repositories.getToolExecution(approval.toolExecutionId)
      if (execution?.toolName === 'write_file' || execution?.toolName === 'replace_file_content') {
        try {
          const result = await overwrites.runApproved(approvalId)
          if (result.status === 'completed' || result.status === 'failed') await repositories.recordApprovedEffect(result.id)
          return result
        } catch (error) {
          const latest = await repositories.getToolExecution(execution.id)
          if (latest?.status === 'completed' || latest?.status === 'failed') await repositories.recordApprovedEffect(latest.id)
          throw error
        }
      }
      if (execution?.toolName !== 'run_process') throw new Error('审批请求不可用')
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        void taskRuns.pauseTaskRun(execution.taskRunId, '受控进程调用超时，等待 CEO 处理', execution.generation).catch(() => {})
      }, 60_000)
      const unsubscribe = taskRuns.onCancelled(execution.taskRunId, () => controller.abort())
      let claimed: Awaited<ReturnType<typeof repositories.claimApprovedProcess>> | undefined
      try {
        claimed = await repositories.claimApprovedProcess(approvalId, new Date().toISOString())
        const input = JSON.parse(claimed.execution.inputJson) as { args: string[] }
        const result = await executeRegisteredProcess({ executable: claimed.executable, args: input.args, cwd: claimed.workspacePath, signal: controller.signal })
        await repositories.finishCancelledProcess(claimed.execution.id)
        const completed = await repositories.finishToolExecution(claimed.execution.id, () => ({ status: result.exitCode === 0 ? 'completed' : 'failed', riskLevel: 'high',
          resultSummary: result.exitCode === null ? '进程已取消' : `进程退出码 ${result.exitCode}${result.stderr ? '; stderr 已截断' : ''}` }))
        if (completed.status === 'completed' || completed.status === 'failed') await repositories.recordApprovedEffect(completed.id)
        return completed
      } catch {
        if (!claimed) throw new Error('审批请求不可用')
        const failed = await repositories.finishToolExecution(claimed.execution.id, () => ({ status: 'failed', riskLevel: 'high', resultSummary: '受控进程执行失败' }))
        if (failed.status === 'completed' || failed.status === 'failed') await repositories.recordApprovedEffect(failed.id)
        return failed
      } finally { clearTimeout(timer); unsubscribe() }
  }
}
