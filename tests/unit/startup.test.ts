import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStartupDatabase } from '../../electron/core/startup'
import { createDatabase } from '../../electron/database/client'

it('offers a sanitized retry after open failure, then prepares the successful database', async () => {
  const database = { close: vi.fn() }
  const open = vi.fn().mockImplementationOnce(() => { throw new Error('PRIVATE_PATH sqlite detail') }).mockReturnValue(database)
  const prepare = vi.fn()
  const showError = vi.fn().mockResolvedValue({ response: 0 })
  const quit = vi.fn()
  const recordFailure = vi.fn()
  expect(await openStartupDatabase({ open, prepare, showError, quit, recordFailure })).toBe(database)
  expect(recordFailure).toHaveBeenCalledTimes(1)
  expect(recordFailure).toHaveBeenCalledWith()
  expect(open).toHaveBeenCalledTimes(2)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledWith(database)
  expect(showError).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['重试', '退出'], cancelId: 1 }))
  expect(JSON.stringify(showError.mock.calls)).not.toContain('PRIVATE_PATH')
  expect(quit).not.toHaveBeenCalled()
  expect(database.close).not.toHaveBeenCalled()
})

it('preserves a corrupt database through retry and exit and closes failed migration handles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-error-'))
  const filePath = join(directory, 'agent-team.sqlite')
  const original = Buffer.from('PRIVATE_DATABASE_CONTENT not a SQLite file')
  await writeFile(filePath, original)
  const close = vi.spyOn(Database.prototype, 'close')
  try {
    const prepare = vi.fn()
    const showError = vi.fn().mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    const quit = vi.fn()
    const result = await openStartupDatabase({ open: () => createDatabase({ filePath }), prepare, showError, quit })
    expect(result).toBeUndefined()
    expect(prepare).not.toHaveBeenCalled()
    expect(showError).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(await readFile(filePath)).toEqual(original)
    expect(JSON.stringify(showError.mock.calls)).not.toContain('PRIVATE_DATABASE_CONTENT')
    expect(JSON.stringify(showError.mock.calls)).not.toContain(filePath)
  } finally {
    close.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

it('closes a database after recovery failure before retrying, and exits on request', async () => {
  const database = { close: vi.fn() }
  const open = vi.fn().mockReturnValue(database)
  const prepare = vi.fn().mockRejectedValue(new Error('PRIVATE_SQL'))
  const showError = vi.fn().mockImplementation(async () => {
    expect(database.close).toHaveBeenCalled()
    return { response: 1 }
  })
  const quit = vi.fn()
  expect(await openStartupDatabase({ open, prepare, showError, quit })).toBeUndefined()
  expect(open).toHaveBeenCalledTimes(1)
  expect(database.close).toHaveBeenCalledTimes(1)
  expect(quit).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(showError.mock.calls)).not.toContain('PRIVATE_SQL')
})
