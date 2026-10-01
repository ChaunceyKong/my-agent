import { constants } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { FileToolLimits, ListDirectoryResult, ReadTextFileResult, SearchTextFilesResult } from '../../shared/types'
import { FileToolError, MAX_PATH_CHARS, resolveSafePath } from './file-sandbox'

export const FILE_TOOL_LIMITS: Readonly<FileToolLimits> = Object.freeze({
  maxPathChars: MAX_PATH_CHARS,
  maxFileBytes: 256 * 1024,
  maxContentChars: 16 * 1024,
  maxDirectoryEntries: 200,
  maxSearchMatches: 100,
  maxExcerptChars: 240,
  maxQueryChars: 256,
  maxVisitedEntries: 2000,
  maxSearchBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxResultChars: 16 * 1024,
})

function relativePath(root: string, path: string): string {
  return relative(resolve(root), path).split(sep).join('/') || '.'
}

function safeError(error: unknown): FileToolError {
  return error instanceof FileToolError ? error : new FileToolError('PATH_UNAVAILABLE', '文件路径不存在或不可访问')
}

// Open with a fixed-size buffer so a file growing after stat cannot cause an unbounded read.
async function readBoundedText(root: string, path: string): Promise<{ content: string; bytes: number }> {
  const target = await resolveSafePath(root, path)
  const before = await lstat(target)
  if (!before.isFile()) throw new FileToolError('NOT_FILE', '目标不是普通文件')
  if (before.size > FILE_TOOL_LIMITS.maxFileBytes) {
    throw new FileToolError('FILE_TOO_LARGE', `文件超过大小限制 ${FILE_TOOL_LIMITS.maxFileBytes} 字节`, FILE_TOOL_LIMITS.maxFileBytes)
  }
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await file.stat()
    // Electron on Windows can report a different `dev` for FileHandle.stat()
    // than lstat(). Inode equality binds the open handle; subsequent path-race
    // checks compare lstat observations only.
    if (!opened.isFile() || opened.ino !== before.ino) {
      throw new FileToolError('FILE_CHANGED', '文件在读取前发生变化')
    }
    await resolveSafePath(root, path)
    const buffer = Buffer.alloc(FILE_TOOL_LIMITS.maxFileBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
    }
    if (bytes > FILE_TOOL_LIMITS.maxFileBytes) {
      throw new FileToolError('FILE_TOO_LARGE', `文件超过大小限制 ${FILE_TOOL_LIMITS.maxFileBytes} 字节`, FILE_TOOL_LIMITS.maxFileBytes)
    }
    const after = await file.stat()
    const current = await lstat(await resolveSafePath(root, path))
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino) {
      throw new FileToolError('FILE_CHANGED', '文件在读取期间发生变化')
    }
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)) } catch {
      throw new FileToolError('INVALID_TEXT', '只允许 UTF-8 文本文件')
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new FileToolError('INVALID_TEXT', '只允许 UTF-8 文本文件')
    return { content, bytes }
  } finally {
    await file.close()
  }
}

export async function readTextFile(root: string, path: string): Promise<ReadTextFileResult> {
  try {
    const result = await readBoundedText(root, path)
    const target = await resolveSafePath(root, path)
    const truncated = result.content.length > FILE_TOOL_LIMITS.maxContentChars
    return {
      path: relativePath(root, target), content: result.content.slice(0, FILE_TOOL_LIMITS.maxContentChars),
      bytes: result.bytes, truncated, limits: FILE_TOOL_LIMITS,
      summary: `读取 ${result.bytes} 字节${truncated ? '，正文已截断' : ''}`,
    }
  } catch (error) { throw safeError(error) }
}

export async function listDirectory(root: string, path: string): Promise<ListDirectoryResult> {
  try {
    const target = await resolveSafePath(root, path)
    if (!(await lstat(target)).isDirectory()) throw new FileToolError('NOT_DIRECTORY', '目标不是目录')
    const result: ListDirectoryResult = { path: relativePath(root, target), entries: [], truncated: false, summary: '', limits: FILE_TOOL_LIMITS }
    let visited = 0
    let resultChars = 0
    const directory = await opendir(target)
    for await (const entry of directory) {
      if (++visited > FILE_TOOL_LIMITS.maxVisitedEntries) { result.truncated = true; break }
      const childPath = `${result.path === '.' ? '' : `${result.path}/`}${entry.name}`
      try {
        const child = await resolveSafePath(root, childPath)
        const info = await lstat(child)
        if (!info.isDirectory() && !info.isFile()) continue
        if (result.entries.length >= FILE_TOOL_LIMITS.maxDirectoryEntries
          || resultChars + childPath.length + entry.name.length > FILE_TOOL_LIMITS.maxResultChars) {
          result.truncated = true
          break
        }
        result.entries.push({ path: childPath, name: entry.name, type: info.isDirectory() ? 'directory' : 'file' })
        resultChars += childPath.length + entry.name.length
      } catch (error) {
        if (!(error instanceof FileToolError)) throw error
      }
    }
    await resolveSafePath(root, path)
    result.entries.sort((a, b) => a.path.localeCompare(b.path))
    result.summary = `列出 ${result.entries.length} 个条目${result.truncated ? '，结果已截断' : ''}`
    return result
  } catch (error) { throw safeError(error) }
}

export async function searchTextFiles(root: string, path: string, query: string): Promise<SearchTextFilesResult> {
  if (typeof query !== 'string' || !query.length || query.length > FILE_TOOL_LIMITS.maxQueryChars || /[\x00-\x1f\x7f]/.test(query)) {
    throw new FileToolError('INVALID_QUERY', `搜索词必须是 1–${FILE_TOOL_LIMITS.maxQueryChars} 字符的单行文本`, FILE_TOOL_LIMITS.maxQueryChars)
  }
  try {
    const target = await resolveSafePath(root, path)
    if (!(await lstat(target)).isDirectory()) throw new FileToolError('NOT_DIRECTORY', '搜索起点必须是目录')
    const result: SearchTextFilesResult = {
      path: relativePath(root, target), matches: [], visitedEntries: 0, searchedBytes: 0, skippedFiles: 0,
      truncated: false, summary: '', limits: FILE_TOOL_LIMITS,
    }
    let resultChars = 0
    let exhausted = false
    async function visit(directoryPath: string, depth: number): Promise<void> {
      const directory = await opendir(await resolveSafePath(root, directoryPath))
      for await (const entry of directory) {
        if (exhausted) break
        if (result.visitedEntries >= FILE_TOOL_LIMITS.maxVisitedEntries) { exhausted = true; result.truncated = true; break }
        result.visitedEntries++
        const childPath = `${directoryPath === '.' ? '' : `${directoryPath}/`}${entry.name}`
        try {
          const child = await resolveSafePath(root, childPath)
          const info = await lstat(child)
          if (info.isDirectory()) {
            if (depth >= FILE_TOOL_LIMITS.maxDepth) { result.truncated = true; continue }
            await visit(childPath, depth + 1)
          } else if (info.isFile()) {
            if (info.size > FILE_TOOL_LIMITS.maxFileBytes) { result.skippedFiles++; continue }
            // Reserve a whole file's budget, including the extra overflow-detection byte.
            if (result.searchedBytes + FILE_TOOL_LIMITS.maxFileBytes + 1 > FILE_TOOL_LIMITS.maxSearchBytes) {
              exhausted = true; result.truncated = true; break
            }
            result.searchedBytes += FILE_TOOL_LIMITS.maxFileBytes + 1
            const text = await readBoundedText(root, childPath)
            result.searchedBytes -= FILE_TOOL_LIMITS.maxFileBytes + 1 - text.bytes
            for (const [index, line] of text.content.split(/\r?\n/).entries()) {
              const position = line.indexOf(query)
              if (position < 0) continue
              const excerpt = line.slice(Math.max(0, position - 40), Math.max(0, position - 40) + FILE_TOOL_LIMITS.maxExcerptChars)
              if (result.matches.length >= FILE_TOOL_LIMITS.maxSearchMatches
                || resultChars + childPath.length + excerpt.length > FILE_TOOL_LIMITS.maxResultChars) {
                exhausted = true; result.truncated = true; break
              }
              result.matches.push({ path: childPath, line: index + 1, excerpt })
              resultChars += childPath.length + excerpt.length
            }
          }
        } catch (error) {
          if (!(error instanceof FileToolError)) throw error
          result.skippedFiles++
        }
      }
      await resolveSafePath(root, directoryPath)
    }
    await visit(result.path, 0)
    result.summary = `找到 ${result.matches.length} 处匹配，跳过 ${result.skippedFiles} 个不可读条目${result.truncated ? '，结果已截断' : ''}`
    return result
  } catch (error) { throw safeError(error) }
}
