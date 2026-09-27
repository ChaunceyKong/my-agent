import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, win32 } from 'node:path'
import type { FileToolErrorCode } from '../../shared/types'
import { isPathWithinRoot, validateWorkspaceRoot } from './workspace-validator'

export const MAX_PATH_CHARS = 1024

export class FileToolError extends Error {
  constructor(public readonly code: FileToolErrorCode, message: string, public readonly limit?: number) {
    super(message)
    this.name = 'FileToolError'
  }
}

const sensitiveNames = new Set([
  '.git', '.git-credentials', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker',
  '.npmrc', '.pypirc', '.netrc', '_netrc', 'credentials', 'credentials.json',
  'secrets', 'secrets.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
])

function validateRelativePath(candidate: string): string[] {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > MAX_PATH_CHARS
    || isAbsolute(candidate) || win32.isAbsolute(candidate) || /[\x00-\x1f<>:"|?*]/.test(candidate)) {
    throw new FileToolError('INVALID_PATH', '只允许工作区内的有效相对路径', MAX_PATH_CHARS)
  }
  const segments = candidate.split(/[\\/]/).filter((part) => part !== '' && part !== '.')
  for (const segment of segments) {
    if (segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      throw new FileToolError('INVALID_PATH', '路径含有越界或平台保留名称')
    }
    const name = segment.toLowerCase()
    if (sensitiveNames.has(name) || name.startsWith('.env') || /^(credentials|secrets)\.(json|ya?ml|toml|ini)$/.test(name)
      || /\.(pem|key|p12|pfx)$/.test(name)) {
      throw new FileToolError('SENSITIVE_PATH', '不允许访问敏感文件或目录')
    }
  }
  return segments
}

// Existing paths only. v0.2 deliberately rejects internal links as well as escaping links.
export async function resolveSafePath(workspaceRoot: string, candidate: string): Promise<string> {
  const segments = validateRelativePath(candidate)
  try {
    if (!isAbsolute(workspaceRoot)) throw new FileToolError('INVALID_PATH', '工作区根必须是已验证的绝对路径')
    const rootInfo = await lstat(workspaceRoot)
    const root = await validateWorkspaceRoot(workspaceRoot)
    if (rootInfo.isSymbolicLink() || relative(resolve(workspaceRoot), root) !== '') {
      throw new FileToolError('LINK_NOT_ALLOWED', '不允许访问链接或重解析路径')
    }
    const target = resolve(root, ...segments)
    if (!isPathWithinRoot(root, target)) throw new FileToolError('INVALID_PATH', '文件路径超出工作区')
    let current = root
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment)
      const info = await lstat(current)
      const canonical = await realpath(current)
      if (info.isSymbolicLink() || !isPathWithinRoot(root, canonical) || relative(current, canonical) !== '') {
        throw new FileToolError('LINK_NOT_ALLOWED', '不允许访问链接或重解析路径')
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new FileToolError('NOT_DIRECTORY', '文件父路径不是目录')
      }
      current = canonical
    }
    return current
  } catch (error) {
    if (error instanceof FileToolError) throw error
    throw new FileToolError('PATH_UNAVAILABLE', '文件路径不存在或不可访问')
  }
}

// Creation permits only a missing leaf; every existing ancestor uses the same sandbox.
export async function resolveSafeWritePath(workspaceRoot: string, candidate: string): Promise<{ path: string; parent: string; exists: boolean }> {
  const segments = validateRelativePath(candidate)
  if (!segments.length) throw new FileToolError('INVALID_PATH', '写入目标必须是文件')
  const parent = await resolveSafePath(workspaceRoot, segments.slice(0, -1).join('/') || '.')
  if (!(await lstat(parent)).isDirectory()) throw new FileToolError('NOT_DIRECTORY', '文件父路径不是目录')
  const target = join(parent, segments[segments.length - 1])
  try {
    await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: target, parent, exists: false }
    throw new FileToolError('PATH_UNAVAILABLE', '文件路径不存在或不可访问')
  }
  const safe = await resolveSafePath(workspaceRoot, candidate)
  if (!(await lstat(safe)).isFile()) throw new FileToolError('NOT_FILE', '目标不是普通文件')
  return { path: safe, parent, exists: true }
}
