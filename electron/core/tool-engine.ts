import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, realpathSync, unlinkSync, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ListDirectoryResult, ReadTextFileResult, SearchTextFilesResult, ToolExecution, ToolPolicySnapshot, ToolRequest } from '../../shared/types'
import type { Repositories, ToolContext, ToolOutcome } from '../database/repositories'
import { FileToolError, resolveSafeWritePath } from './file-sandbox'
import { FILE_TOOL_LIMITS, listDirectory, readTextFile, searchTextFiles } from './file-tools'

type ReadResult = ListDirectoryResult | ReadTextFileResult | SearchTextFilesResult
export interface ToolResponse { execution: ToolExecution; result?: ReadResult }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error('工具参数无效')
  return value as Record<string, unknown>
}

export function validateToolRequest(value: unknown): ToolRequest {
  const request = object(value, ['toolName', 'input'])
  const name = request.toolName
  if (!['list_dir', 'read_file', 'search_files', 'write_file', 'run_process'].includes(name as string)) throw new Error('工具不支持')
  const input = object(request.input, name === 'write_file' ? ['path', 'content'] : name === 'search_files' ? ['path', 'query'] : name === 'run_process' ? ['executableId', 'args'] : ['path'])
  if (name === 'run_process') {
    if (typeof input.executableId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.executableId)
      || !Array.isArray(input.args) || input.args.length > 32 || input.args.some((arg) => typeof arg !== 'string')) throw new Error('进程参数无效')
    return { toolName: 'run_process', input: { executableId: input.executableId, args: input.args as string[] } }
  }
  if (typeof input.path !== 'string' || !input.path.trim() || input.path.length > FILE_TOOL_LIMITS.maxPathChars) throw new Error('工具路径无效')
  if (name === 'write_file') {
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > FILE_TOOL_LIMITS.maxFileBytes
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.content)
      || Buffer.from(input.content, 'utf8').toString('utf8') !== input.content) throw new Error('只允许大小受限的 UTF-8 文本')
    return { toolName: name, input: { path: input.path, content: input.content } }
  }
  if (name === 'search_files') {
    if (typeof input.query !== 'string' || !input.query.length || input.query.length > FILE_TOOL_LIMITS.maxQueryChars
      || /[\x00-\x1f\x7f]/.test(input.query)) throw new Error('搜索词无效')
    return { toolName: name, input: { path: input.path, query: input.query } }
  }
  return { toolName: name as 'read_file' | 'list_dir', input: { path: input.path } }
}

const pending: ToolOutcome = { status: 'waiting_approval', riskLevel: 'high', resultSummary: '目标已存在，覆盖需要审批' }

function unchanged(path: string, expected: Stats): void {
  const current = lstatSync(path)
  if (current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino
    || relative(path, realpathSync(path)) !== '') throw new FileToolError('FILE_CHANGED', '文件路径已变化')
}

export function createToolEngine(repositories: Repositories, approval?: { request(toolExecutionId: string): Promise<unknown> }) {
  return {
    async execute(context: ToolContext, value: unknown): Promise<ToolResponse> {
      const request = validateToolRequest(value)
      const approvalService = approval
      if (request.toolName === 'run_process' && !approvalService) throw new Error('审批服务不可用')
      const execution = await repositories.createToolExecution(context, request)
      if (request.toolName === 'run_process') {
        await approvalService!.request(execution.id)
        return { execution: (await repositories.getToolExecution(execution.id))! }
      }
      const { workspacePath: root } = JSON.parse(execution.policySnapshotJson) as ToolPolicySnapshot
      try {
        if (request.toolName === 'write_file') {
          return { execution: await writeDraft(root, request.input.path, request.input.content, execution.id) }
        }
        let result: ReadResult
        if (request.toolName === 'read_file') result = await readTextFile(root, request.input.path)
        else if (request.toolName === 'list_dir') result = await listDirectory(root, request.input.path)
        else result = await searchTextFiles(root, request.input.path, request.input.query)
        const completed = await repositories.finishToolExecution(execution.id, () => ({ status: 'completed', riskLevel: 'low', resultSummary: result.summary }))
        return completed.status === 'completed' ? { execution: completed, result } : { execution: completed }
      } catch (error) {
        const code = error instanceof FileToolError ? error.code : 'PATH_UNAVAILABLE'
        return { execution: await repositories.finishToolExecution(execution.id, () => ({
          status: 'failed', riskLevel: execution.riskLevel, resultSummary: `工具执行失败 (${code})`,
        })) }
      }
    },
  }

  async function writeDraft(root: string, path: string, content: string, executionId: string): Promise<ToolExecution> {
    const target = await resolveSafeWritePath(root, path)
    if (target.exists) return repositories.finishToolExecution(executionId, () => pending)
    const parent = await lstat(target.parent)
    const temporary = join(target.parent, `.agent-team-${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    let identity: Stats | undefined
    try {
      identity = await file.stat()
      // Recheck the parent after opening and before putting any body into the handle.
      await resolveSafeWritePath(root, path)
      unchanged(target.parent, parent)
      await file.writeFile(content, 'utf8')
      await file.sync()
      await file.close()
      await resolveSafeWritePath(root, path)
      return await repositories.finishToolExecution(executionId, () => {
        unchanged(target.parent, parent)
        unchanged(temporary, identity!)
        try {
          // Node rename overwrites existing targets. Hard-link publication is atomic and
          // fails with EEXIST instead; unlinking the private temp completes the move.
          linkSync(temporary, target.path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const conflict = lstatSync(target.path)
          if (conflict.isSymbolicLink() || relative(target.path, realpathSync(target.path)) !== '') throw new FileToolError('LINK_NOT_ALLOWED', '不允许访问链接')
          if (!conflict.isFile()) throw new FileToolError('NOT_FILE', '目标不是普通文件')
          return pending
        }
        return { status: 'completed', riskLevel: 'medium', resultSummary: `已新建文件，${Buffer.byteLength(content, 'utf8')} 字节` }
      })
    } finally {
      await file.close()
      // Never remove a substituted path if another local writer changed the parent/temp.
      if (identity) {
        try {
          unchanged(target.parent, parent)
          unchanged(temporary, identity)
          unlinkSync(temporary)
        } catch { /* Preserve any uncertain path for manual cleanup. */ }
      }
    }
  }
}
