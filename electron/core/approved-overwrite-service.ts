import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, realpathSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { OverwritePublication, OverwriteTargetIdentity, ToolExecution } from '../../shared/types'
import type { Repositories } from '../database/repositories'
import { FileToolError, resolveSafeWritePath } from './file-sandbox'
import type { ExecutionGate } from './execution-gate'

const names = (value: string, suffix: '.tmp' | '.backup') => new RegExp(`^\\.agent-team-[0-9a-f-]{36}\\${suffix}$`).test(value)
const inode = (actual: Stats, expected: OverwriteTargetIdentity) => actual.isFile() && !actual.isSymbolicLink() && actual.dev === expected.dev && actual.ino === expected.ino
const same = (actual: Stats, expected: OverwriteTargetIdentity) => inode(actual, expected) && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.ctimeMs === expected.ctimeMs
function unchanged(path: string, expected: Stats) { const current = lstatSync(path); if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || relative(path, realpathSync(path)) !== '') throw new FileToolError('FILE_CHANGED', '文件路径已变化') }
async function captureTemporaryIdentity(file: Awaited<ReturnType<typeof open>>, path: string): Promise<Stats> {
  const handle = await file.stat(); const current = await lstat(path)
  if (current.isSymbolicLink() || !current.isFile() || handle.ino !== current.ino || relative(path, realpathSync(path)) !== '') throw new FileToolError('FILE_CHANGED', '临时文件已变化')
  // Electron on Windows can report FileHandle.stat().dev differently from lstat().
  // Inode equality binds the open handle; later checks deliberately keep lstat identity.
  return current
}
function parse(execution: ToolExecution): { path: string; content: string; old: OverwriteTargetIdentity } {
  try { const input = JSON.parse(execution.inputJson) as Record<string, unknown>; const old = JSON.parse(execution.overwriteTargetIdentityJson ?? '') as Record<string, unknown>
    if (Object.keys(input).length !== 2 || typeof input.path !== 'string' || typeof input.content !== 'string' || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => typeof old[key] === 'number' && Number.isFinite(old[key]))) throw new Error()
    return { path: input.path, content: input.content, old: old as unknown as OverwriteTargetIdentity }
  } catch { throw new Error('审批请求不可用') }
}
function temp(value: string | null) { try { const v = JSON.parse(value ?? '') as Record<string, unknown>; return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((k) => typeof v[k] === 'number') ? v as unknown as OverwriteTargetIdentity : undefined } catch { return undefined } }

/** An approved replace is the sole no-delete exception. Its DB journal is committed before every FS phase; DB and FS are deliberately not claimed atomic. */
export function createApprovedOverwriteService(repositories: Repositories, clock: () => Date = () => new Date(), fileOps: { unlink(path: string): void } = { unlink: unlinkSync }, gate?: ExecutionGate) {
  const service = {
    async runApproved(approvalId: string): Promise<ToolExecution> {
      const claim = await repositories.claimApprovedOverwrite(approvalId, clock().toISOString(), `.agent-team-${randomUUID()}.tmp`, `.agent-team-${randomUUID()}.backup`)
      try {
        const input = parse(claim.execution)
        let publication = await stage(claim.workspacePath, claim.publication, input)
        publication = await repositories.markOverwritePublishing(claim.execution.id)
        publication = await repositories.claimOverwriteEffect(claim.execution.id)
        await publish(claim.workspacePath, publication, input)
        publication = await repositories.markOverwritePublished(claim.execution.id)
        const completed = await repositories.completeOverwritePublication(claim.execution.id)
        if (!await cleanup(claim.workspacePath, publication, input)) await repositories.markOverwriteCleanupPending(claim.execution.id)
        return completed
      } catch {
        const current = (await repositories.listRecoverableOverwritePublications()).find((item) => item.publication.executionId === claim.execution.id)
        if (current) await recoverOne(current)
        return (await repositories.getToolExecution(claim.execution.id))!
      }
    },
    async recoverInterruptedPublications() { for (const record of await repositories.listRecoverableOverwritePublications()) await recoverOne(record) },
  }
  if (gate) service.runApproved = gate.protect(service.runApproved)
  return service
  async function stage(root: string, publication: OverwritePublication, input: ReturnType<typeof parse>) {
    const target = await resolveSafeWritePath(root, input.path); if (!target.exists || !same(await lstat(target.path), input.old)) throw new FileToolError('FILE_CHANGED', '目标文件已变化')
    const parent = await lstat(target.parent); const path = join(target.parent, publication.temporaryRelativePath); const file = await open(path, 'wx', 0o600)
    try { const info = await captureTemporaryIdentity(file, path); await file.writeFile(input.content, 'utf8'); await file.sync(); await file.close(); unchanged(target.parent, parent); unchanged(path, info); if (!same(await lstat(target.path), input.old)) throw new FileToolError('FILE_CHANGED', '目标文件已变化')
      const staged = await lstat(path)
      return repositories.markOverwriteStaged(publication.executionId, JSON.stringify({ dev: staged.dev, ino: staged.ino, size: staged.size, mtimeMs: staged.mtimeMs, ctimeMs: staged.ctimeMs }))
    } finally { await file.close() }
  }
  async function publish(root: string, publication: OverwritePublication, input: ReturnType<typeof parse>) {
    const staged = temp(publication.temporaryIdentityJson); if (!staged) throw new Error('覆盖发布状态不可用')
    const target = await resolveSafeWritePath(root, input.path); if (!target.exists || !same(await lstat(target.path), input.old)) throw new FileToolError('FILE_CHANGED', '目标文件已变化')
    const parent = await lstat(target.parent); const source = join(target.parent, publication.temporaryRelativePath); const backup = join(target.parent, publication.backupRelativePath)
    unchanged(target.parent, parent); if (!inode(lstatSync(source), staged)) throw new FileToolError('FILE_CHANGED', '临时文件已变化')
    // No FS effect occurs in a DB transaction. Keep backup and temp until completion is durable.
    renameSync(target.path, backup); try { if (!inode(lstatSync(backup), input.old)) throw new FileToolError('FILE_CHANGED', '目标文件已变化'); linkSync(source, target.path) } catch (error) { if (!existsSync(target.path)) { try { renameSync(backup, target.path) } catch {} } throw error }
  }
  async function cleanup(root: string, publication: OverwritePublication, input: ReturnType<typeof parse>): Promise<boolean> {
    try { const target = await resolveSafeWritePath(root, input.path); const staged = temp(publication.temporaryIdentityJson); if (!target.exists || !staged) return false
      const source = join(target.parent, publication.temporaryRelativePath); const backup = join(target.parent, publication.backupRelativePath)
      if (existsSync(backup) && inode(lstatSync(backup), input.old)) fileOps.unlink(backup)
      if (existsSync(source) && inode(lstatSync(source), staged)) fileOps.unlink(source)
      return true
    } catch { return false }
  }
  async function recoverOne(record: { publication: OverwritePublication; execution: ToolExecution; workspacePath: string }) {
    let input: ReturnType<typeof parse>; try { input = parse(record.execution) } catch { await repositories.recoverOverwritePublication(record.publication.executionId, 'needs_recovery', '覆盖发布需要人工恢复'); return }
    if (!names(record.publication.temporaryRelativePath, '.tmp') || !names(record.publication.backupRelativePath, '.backup')) { await repositories.recoverOverwritePublication(record.publication.executionId, 'needs_recovery', '覆盖发布需要人工恢复'); return }
    let target; try { target = await resolveSafeWritePath(record.workspacePath, input.path) } catch { await repositories.recoverOverwritePublication(record.publication.executionId, 'needs_recovery', '覆盖发布需要人工恢复'); return }
    const staged = temp(record.publication.temporaryIdentityJson); const source = join(target.parent, record.publication.temporaryRelativePath); const backup = join(target.parent, record.publication.backupRelativePath); const old = existsSync(backup) ? lstatSync(backup) : undefined; const current = target.exists ? await lstat(target.path).catch(() => undefined) : undefined
    if (['preparing', 'staged'].includes(record.publication.state) && !old && current && same(current, input.old) && staged && existsSync(source) && inode(lstatSync(source), staged)) {
      try { fileOps.unlink(source); await repositories.recoverOverwritePublication(record.publication.executionId, 'recovered', '覆盖未发布，已清理临时文件') } catch { await repositories.markOverwriteCleanupPending(record.publication.executionId) }
      return
    }
    if (record.publication.state === 'cleanup_pending' && current && staged && inode(current, staged)) { if (await cleanup(record.workspacePath, record.publication, input)) await repositories.markOverwriteCleanupComplete(record.publication.executionId); return }
    if (old && inode(old, input.old) && current && staged && inode(current, staged)) { try { if (record.publication.state === 'effect_claimed') await repositories.markOverwritePublished(record.publication.executionId); await repositories.completeOverwritePublication(record.publication.executionId); if (!await cleanup(record.workspacePath, record.publication, input)) await repositories.markOverwriteCleanupPending(record.publication.executionId) } catch {} return }
    if (old && inode(old, input.old) && !current) { try { renameSync(backup, target.path); await repositories.recoverOverwritePublication(record.publication.executionId, 'recovered', '覆盖发布已恢复，未替换文件') } catch { await repositories.recoverOverwritePublication(record.publication.executionId, 'needs_recovery', '覆盖发布需要人工恢复') }; return }
    if (!old && current && staged && inode(current, staged)) { try { await repositories.completeOverwritePublication(record.publication.executionId); if (!await cleanup(record.workspacePath, record.publication, input)) await repositories.markOverwriteCleanupPending(record.publication.executionId) } catch {}; return }
    if (!old && current && same(current, input.old)) { await repositories.recoverOverwritePublication(record.publication.executionId, 'recovered', '覆盖未发布，已安全恢复'); return }
    await repositories.recoverOverwritePublication(record.publication.executionId, 'needs_recovery', '覆盖发布需要人工恢复')
  }
}
