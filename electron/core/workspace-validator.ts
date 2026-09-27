import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export function isPathWithinRoot(root: string, target: string): boolean {
  const difference = relative(root, target)
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`))
}

export async function validateWorkspaceRoot(candidate: string): Promise<string> {
  try {
    await access(candidate, constants.R_OK)
    const canonicalRoot = await realpath(candidate)
    if (!(await lstat(canonicalRoot)).isDirectory()) throw new Error('not a directory')
    return canonicalRoot
  } catch {
    throw new Error('工作区路径不存在或不可访问')
  }
}
