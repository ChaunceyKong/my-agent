import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSafePath } from '../../electron/core/file-sandbox'
import { isPathWithinRoot } from '../../electron/core/workspace-validator'

let fixture: string
let root: string

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'agent-team-sandbox-'))
  root = join(fixture, 'workspace')
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'nested', 'hello.txt'), 'hello')
})

afterEach(async () => { await rm(fixture, { recursive: true, force: true }) })

describe('resolveSafePath', () => {
  it('resolves a safe nested file and the root', async () => {
    await expect(resolveSafePath(root, 'nested/hello.txt')).resolves.toBe(await realpath(join(root, 'nested', 'hello.txt')))
    await expect(resolveSafePath(root, '.')).resolves.toBe(await realpath(root))
  })

  it.each(['', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:secret', '\\\\server\\share', '../outside', 'nested/../../outside', 'nested/../hello.txt', 'a\0b', 'NUL.txt', 'con', 'COM1', 'file:stream', 'file.', 'file ', 'nested\\..\\outside'])('rejects unsafe path %j', async (path) => {
    await expect(resolveSafePath(root, path)).rejects.toThrow()
  })

  it('rejects a sibling with a shared root prefix', async () => {
    await mkdir(join(fixture, 'workspace-other'))
    await writeFile(join(fixture, 'workspace-other', 'secret.txt'), 'secret')
    await expect(resolveSafePath(root, '../workspace-other/secret.txt')).rejects.toThrow()
    await expect(resolveSafePath(root, join(fixture, 'workspace-other', 'secret.txt'))).rejects.toThrow()
    expect(isPathWithinRoot(root, join(fixture, 'workspace-other', 'secret.txt'))).toBe(false)
    expect(isPathWithinRoot(root, join(root, 'nested', 'hello.txt'))).toBe(true)
  })

  it.each(['.env', '.ENV.local', '.envrc', '.git/config', '.git-credentials', '.ssh/id_rsa', '.aws/credentials', 'secrets/token.txt', '.npmrc', 'credentials.json', 'secrets.yaml', 'server.key', 'private.pem'])('rejects sensitive path %s', async (path) => {
    await expect(resolveSafePath(root, path)).rejects.toThrow('敏感')
  })

  it('rejects escaping junctions and internal links, including linked roots', async () => {
    await mkdir(join(fixture, 'outside'))
    await writeFile(join(fixture, 'outside', 'secret.txt'), 'secret')
    await symlink(join(fixture, 'outside'), join(root, 'escape'), 'junction')
    await symlink(join(root, 'nested'), join(root, 'alias'), 'junction')
    await expect(resolveSafePath(root, 'escape/secret.txt')).rejects.toThrow()
    await expect(resolveSafePath(root, 'alias/hello.txt')).rejects.toThrow()
    await expect(resolveSafePath(join(root, 'escape'), 'secret.txt')).rejects.toThrow()
  })

  it('fails closed for missing targets without exposing absolute paths', async () => {
    await expect(resolveSafePath(root, 'missing.txt')).rejects.toThrow('文件路径不存在或不可访问')
    await expect(resolveSafePath(root, 'missing.txt')).rejects.not.toThrow(root)
  })
})
