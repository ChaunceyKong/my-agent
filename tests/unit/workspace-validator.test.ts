import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateWorkspaceRoot } from '../../electron/core/workspace-validator'

const fixtureRoots: string[] = []

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('validateWorkspaceRoot', () => {
  it('rejects a missing workspace root', async () => {
    await expect(validateWorkspaceRoot('Z:/does-not-exist')).rejects.toThrow('工作区路径不存在')
  })

  it('returns the canonical workspace root', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-team-workspace-'))
    fixtureRoots.push(fixtureRoot)

    await expect(validateWorkspaceRoot(join(fixtureRoot, '.'))).resolves.toBe(await realpath(fixtureRoot))
  })
})
