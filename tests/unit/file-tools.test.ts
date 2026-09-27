import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FILE_TOOL_LIMITS, listDirectory, readTextFile, searchTextFiles } from '../../electron/core/file-tools'

let fixture: string
let root: string

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'agent-team-file-tools-'))
  root = join(fixture, 'workspace')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'nested', 'hello.txt'), '你好 world\nsecond world')
})

afterEach(async () => { await rm(fixture, { recursive: true, force: true }) })

describe('readTextFile', () => {
  it('returns UTF-8 text with relative paths and content-free summary', async () => {
    const result = await readTextFile(root, 'nested/hello.txt')
    expect(result).toMatchObject({ path: 'nested/hello.txt', content: '你好 world\nsecond world', truncated: false, bytes: 25 })
    expect(result.summary).not.toContain('你好')
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it.each([Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe]), Buffer.from([0x68, 0x01])])('rejects binary or invalid UTF-8 input', async (buffer) => {
    await writeFile(join(root, 'binary.bin'), buffer)
    await expect(readTextFile(root, 'binary.bin')).rejects.toThrow('UTF-8')
  })

  it('rejects oversized input and truncates accepted long text', async () => {
    await writeFile(join(root, 'large.txt'), 'a'.repeat(FILE_TOOL_LIMITS.maxFileBytes + 1))
    await expect(readTextFile(root, 'large.txt')).rejects.toThrow('大小')
    await writeFile(join(root, 'long.txt'), 'a'.repeat(FILE_TOOL_LIMITS.maxContentChars + 1))
    const result = await readTextFile(root, 'long.txt')
    expect(result.content.length).toBe(FILE_TOOL_LIMITS.maxContentChars)
    expect(result.truncated).toBe(true)
    expect(result.summary.length).toBeLessThan(256)
  })

  it('rejects directories and sensitive file reads', async () => {
    await expect(readTextFile(root, '.')).rejects.toThrow()
    await writeFile(join(root, '.env'), 'TOP_SECRET')
    await expect(readTextFile(root, '.env')).rejects.toThrow('敏感')
  })
})

describe('listDirectory', () => {
  it('omits sensitive paths and junctions and exposes only relative names', async () => {
    await writeFile(join(root, '.env'), 'TOP_SECRET')
    await mkdir(join(root, '.git'))
    await symlink(join(root, 'nested'), join(root, 'alias'), 'junction')
    const result = await listDirectory(root, '.')
    expect(result.entries).toEqual([{ path: 'nested', name: 'nested', type: 'directory' }])
    expect(result.truncated).toBe(false)
    expect(JSON.stringify(result)).not.toContain(root)
  })

  it('bounds entries and reports truncation', async () => {
    await Promise.all(Array.from({ length: FILE_TOOL_LIMITS.maxDirectoryEntries + 1 }, (_, i) => writeFile(join(root, `file-${i}.txt`), 'x')))
    const result = await listDirectory(root, '.')
    expect(result.entries.length).toBe(FILE_TOOL_LIMITS.maxDirectoryEntries)
    expect(result.truncated).toBe(true)
  })
})

describe('searchTextFiles', () => {
  it('finds literal matches with relative paths, lines and bounded excerpts', async () => {
    await writeFile(join(root, 'literal.txt'), 'a.*b\naZZb')
    const result = await searchTextFiles(root, '.', 'world')
    expect(result.matches).toEqual([
      { path: 'nested/hello.txt', line: 1, excerpt: '你好 world' },
      { path: 'nested/hello.txt', line: 2, excerpt: 'second world' },
    ])
    expect(result.summary).not.toContain('world')
    expect((await searchTextFiles(root, '.', 'a.*b')).matches).toHaveLength(1)
  })

  it('skips secrets, junction escapes, binary and oversized files', async () => {
    await writeFile(join(root, '.env'), 'world SECRET')
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'world SECRET')
    await writeFile(join(root, 'binary.bin'), Buffer.from('world\0SECRET'))
    await writeFile(join(root, 'huge.txt'), 'world'.repeat(FILE_TOOL_LIMITS.maxFileBytes))
    await mkdir(join(fixture, 'outside'))
    await writeFile(join(fixture, 'outside', 'secret.txt'), 'world SECRET')
    await symlink(join(fixture, 'outside'), join(root, 'escape'), 'junction')
    const result = await searchTextFiles(root, '.', 'world')
    expect(result.matches).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('bounds hits', async () => {
    await writeFile(join(root, 'many.txt'), 'needle\n'.repeat(FILE_TOOL_LIMITS.maxSearchMatches + 1))
    const result = await searchTextFiles(root, '.', 'needle')
    expect(result.matches).toHaveLength(FILE_TOOL_LIMITS.maxSearchMatches)
    expect(result.truncated).toBe(true)
  })

  it('bounds excerpts and aggregate result characters', async () => {
    await writeFile(join(root, 'many.txt'), Array.from({ length: 100 }, () => `needle ${'x'.repeat(500)}`).join('\n'))
    const result = await searchTextFiles(root, '.', 'needle')
    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches.every((match) => match.excerpt.length <= FILE_TOOL_LIMITS.maxExcerptChars)).toBe(true)
    expect(result.matches.reduce((total, match) => total + match.path.length + match.excerpt.length, 0)).toBeLessThanOrEqual(FILE_TOOL_LIMITS.maxResultChars)
    expect(result.truncated).toBe(true)
  })

  it('bounds recursive depth without returning deeper content', async () => {
    const nested = Array.from({ length: FILE_TOOL_LIMITS.maxDepth + 1 }, () => 'd')
    await mkdir(join(root, ...nested), { recursive: true })
    await writeFile(join(root, ...nested, 'secret.txt'), 'needle')
    const result = await searchTextFiles(root, '.', 'needle')
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('bounds the aggregate bytes read even without matches', async () => {
    const count = Math.ceil(FILE_TOOL_LIMITS.maxSearchBytes / FILE_TOOL_LIMITS.maxFileBytes) + 1
    await Promise.all(Array.from({ length: count }, (_, i) => writeFile(join(root, `bytes-${i}.txt`), 'x'.repeat(FILE_TOOL_LIMITS.maxFileBytes))))
    const result = await searchTextFiles(root, '.', 'absent')
    expect(result.matches).toEqual([])
    expect(result.searchedBytes).toBeLessThanOrEqual(FILE_TOOL_LIMITS.maxSearchBytes)
    expect(result.truncated).toBe(true)
  })

  it('bounds visited entries independently of matching files', async () => {
    await Promise.all(Array.from({ length: FILE_TOOL_LIMITS.maxVisitedEntries + 1 }, (_, i) => writeFile(join(root, `.env.${i}`), 'needle')))
    const result = await searchTextFiles(root, '.', 'needle')
    expect(result.matches).toEqual([])
    expect(result.visitedEntries).toBe(FILE_TOOL_LIMITS.maxVisitedEntries)
    expect(result.truncated).toBe(true)
  })

  it.each(['', '\0', 'a'.repeat(257)])('rejects invalid query %j', async (query) => {
    await expect(searchTextFiles(root, '.', query)).rejects.toThrow()
  })
})
