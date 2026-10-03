import { expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ app: { isPackaged: false }, updater: { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() } }))
vi.mock('electron', () => ({ app: mock.app }))
vi.mock('electron-updater', () => ({ autoUpdater: mock.updater }))
import { createDesktopUpdateAdapter, hasPublisherIdentity, observeInstall, updateDisabledReason } from '../../electron/core/update-adapter'

it('current build returns disabled before update metadata/network actions', () => {
  expect(createDesktopUpdateAdapter()).toEqual({ disabledReason: 'development' })
  mock.app.isPackaged = true
  expect(createDesktopUpdateAdapter()).toEqual({ disabledReason: process.platform === 'win32' ? 'unconfigured' : 'unsupported' })
  expect(mock.updater.checkForUpdates).not.toHaveBeenCalled(); expect(mock.updater.downloadUpdate).not.toHaveBeenCalled(); expect(mock.updater.quitAndInstall).not.toHaveBeenCalled()
})
it.each([
  [{ packaged: false, platform: 'win32', portable: false, trusted: true, signed: true }, 'development'],
  [{ packaged: true, platform: 'win32', portable: true, trusted: true, signed: true }, 'portable'],
  [{ packaged: true, platform: 'linux', portable: false, trusted: true, signed: true }, 'unsupported'],
  [{ packaged: true, platform: 'win32', portable: false, trusted: false, signed: true }, 'unconfigured'],
  [{ packaged: true, platform: 'win32', portable: false, trusted: true, signed: false }, 'signing-unavailable'],
  [{ packaged: true, platform: 'win32', portable: false, trusted: true, signed: true }, null],
] as const)('unavailable build fence %#', (input, reason) => { expect(updateDisabledReason(input)).toBe(reason) })
it.each(['null', '~', '[]', '""', "''", '"  "', '# no identity', '[publisher, null]', '[publisher, ""]'])('rejects parsed empty/invalid publisher %s', (value) => {
  expect(hasPublisherIdentity(`publisherName: ${value}`)).toBe(false)
})
it.each(['publisher', '"publisher"', '[publisher, second]', '\n  - publisher\n  - second'])('accepts nonempty publisher schema %s without replacing verifier', (value) => {
  expect(hasPublisherIdentity(`publisherName: ${value}`)).toBe(true)
})
it.each([false, true])('observes actual v6 synchronous install result %s and restores method/receiver', (value) => {
  const original = vi.fn(function (this: unknown, silent?: boolean, runAfter?: boolean) { expect(this).toBe(updater); expect([silent, runAfter]).toEqual([false, true]); return value })
  const updater = { install: original, quitAndInstall(silent?: boolean, runAfter?: boolean) { this.install(silent, runAfter) } }
  expect(observeInstall(updater)).toBe(value); expect(updater.install).toBe(original)
})
it('preserves unknown throw and restores original method rather than inventing false', () => {
  const original = vi.fn(() => { throw new Error('unknown') })
  const updater = { install: original, quitAndInstall() { this.install() } }
  expect(() => observeInstall(updater)).toThrow('unknown'); expect(updater.install).toBe(original)
})
