import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'

export async function validateWorkspaceRoot(candidate: string): Promise<string> {
  try {
    await access(candidate, constants.R_OK)
    const canonicalRoot = await realpath(candidate)
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('not a directory')
    return canonicalRoot
  } catch {
    throw new Error('工作区路径不存在或不可访问')
  }
}
