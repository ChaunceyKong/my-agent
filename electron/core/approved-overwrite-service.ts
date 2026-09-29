import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, realpathSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { OverwriteTargetIdentity, ToolExecution } from '../../shared/types'
import type { Repositories } from '../database/repositories'
import { FileToolError, resolveSafeWritePath } from './file-sandbox'

function sameIdentity(actual: Stats, expected: OverwriteTargetIdentity): boolean {
  return actual.isFile() && !actual.isSymbolicLink()
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs
}

function unchanged(path: string, expected: Stats): void {
  const current = lstatSync(path)
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino
    || relative(path, realpathSync(path)) !== '') throw new FileToolError('FILE_CHANGED', '文件路径已变化')
}

function parseInput(execution: ToolExecution): { path: string; content: string; identity: OverwriteTargetIdentity } {
  try {
    const input = JSON.parse(execution.inputJson) as Record<string, unknown>
    const identity = JSON.parse(execution.overwriteTargetIdentityJson ?? '') as Record<string, unknown>
    if (Object.keys(input).length !== 2 || typeof input.path !== 'string' || typeof input.content !== 'string'
      || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => typeof identity[key] === 'number' && Number.isFinite(identity[key]))) throw new Error()
    return { path: input.path, content: input.content, identity: identity as unknown as OverwriteTargetIdentity }
  } catch { throw new Error('审批请求不可用') }
}

/** Executes an approved replacement only after a separate explicit renderer action. */
export function createApprovedOverwriteService(repositories: Repositories, clock: () => Date = () => new Date()) {
  return {
    async runApproved(approvalId: string): Promise<ToolExecution> {
      const claim = await repositories.claimApprovedOverwrite(approvalId, clock().toISOString())
      try {
        const input = parseInput(claim.execution)
        return await replace(claim.workspacePath, input.path, input.content, input.identity, claim.execution.id)
      } catch {
        return repositories.finishToolExecution(claim.execution.id, () => ({ status: 'failed', riskLevel: 'high', resultSummary: '已批准的覆盖操作失败' }))
      }
    },
  }

  async function replace(root: string, path: string, content: string, expected: OverwriteTargetIdentity, executionId: string): Promise<ToolExecution> {
    const target = await resolveSafeWritePath(root, path)
    if (!target.exists || !sameIdentity(await lstat(target.path), expected)) throw new FileToolError('FILE_CHANGED', '目标文件已变化')
    const parent = await lstat(target.parent)
    const temporary = join(target.parent, `.agent-team-${randomUUID()}.tmp`)
    const backup = join(target.parent, `.agent-team-${randomUUID()}.backup`)
    const file = await open(temporary, 'wx', 0o600)
    let tempIdentity: Stats | undefined
    let published = false
    try {
      tempIdentity = await file.stat()
      await resolveSafeWritePath(root, path)
      unchanged(target.parent, parent)
      if (!sameIdentity(await lstat(target.path), expected)) throw new FileToolError('FILE_CHANGED', '目标文件已变化')
      await file.writeFile(content, 'utf8')
      await file.sync()
      await file.close()
      await resolveSafeWritePath(root, path)
      return await repositories.finishToolExecution(executionId, () => {
        unchanged(target.parent, parent)
        unchanged(temporary, tempIdentity!)
        const current = lstatSync(target.path)
        if (!sameIdentity(current, expected) || relative(target.path, realpathSync(target.path)) !== '') throw new FileToolError('FILE_CHANGED', '目标文件已变化')
        // Move the approved file aside first, then atomically link the staged body. If a
        // concurrent writer claims the name, linking fails instead of overwriting it.
        renameSync(target.path, backup)
        try {
          const moved = lstatSync(backup)
          // Moving a directory entry updates ctime, so identity after the move is inode-bound.
          if (!moved.isFile() || moved.isSymbolicLink() || moved.dev !== expected.dev || moved.ino !== expected.ino) throw new FileToolError('FILE_CHANGED', '目标文件已变化')
          linkSync(temporary, target.path)
          published = true
          unlinkSync(backup)
        } catch (error) {
          if (!existsSync(target.path)) {
            try { renameSync(backup, target.path) } catch { /* Preserve uncertain state without overwriting a racer. */ }
          }
          throw error
        }
        return { status: 'completed', riskLevel: 'high', resultSummary: `已按批准覆盖文件，${Buffer.byteLength(content, 'utf8')} 字节` }
      })
    } finally {
      await file.close()
      if (tempIdentity && !published) {
        try { unchanged(target.parent, parent); unchanged(temporary, tempIdentity); unlinkSync(temporary) } catch { /* Preserve uncertain paths. */ }
      }
      if (published) {
        try { unchanged(target.parent, parent); unchanged(temporary, tempIdentity!); unlinkSync(temporary) } catch { /* Publication already succeeded; preserve uncertain temp. */ }
      }
    }
  }
}
