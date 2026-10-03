import { app } from 'electron'
import { autoUpdater, type NsisUpdater } from 'electron-updater'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateStatus } from '../../shared/types'
import type { UpdateAdapter } from './update-service'

// No trusted release host/signing identity has been supplied. Change only in a reviewed
// release build alongside its packaged app-update.yml; never read approval/feed from IPC/env.
const trustedReleaseConfigured = false

export function hasPublisherIdentity(text: string): boolean {
  try {
    // Use the same YAML parser/version family as electron-updater's configOnDisk.
    const { load } = require('js-yaml') as { load(text: string): unknown }
    const config = load(text)
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false
    const names = (config as Record<string, unknown>).publisherName
    return typeof names === 'string' ? !!names.trim()
      : Array.isArray(names) && names.length > 0 && names.every((name) => typeof name === 'string' && !!name.trim())
  } catch { return false }
}

export function updateDisabledReason(input: { packaged: boolean; platform: string; portable: boolean; trusted: boolean; signed: boolean }): UpdateStatus['reason'] {
  if (!input.packaged) return 'development'
  if (input.portable) return 'portable'
  if (input.platform !== 'win32') return 'unsupported'
  if (!input.trusted) return 'unconfigured'
  if (!input.signed) return 'signing-unavailable'
  return null
}

export function observeInstall(updater: Pick<NsisUpdater, 'install' | 'quitAndInstall'>): boolean {
  const original = updater.install
  let accepted = false
  updater.install = function (...args) { accepted = original.apply(this, args); return accepted }
  try { updater.quitAndInstall(false, true); return accepted } finally { updater.install = original }
}

export function createDesktopUpdateAdapter(): { disabledReason?: UpdateStatus['reason']; adapter?: UpdateAdapter } {
  // Short-circuit before touching feed metadata or updater actions in unavailable modes.
  const preliminary = updateDisabledReason({ packaged: app.isPackaged, platform: process.platform,
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR, trusted: trustedReleaseConfigured, signed: true })
  if (preliminary) return { disabledReason: preliminary }
  const config = join(process.resourcesPath, 'app-update.yml')
  // NSIS skips signature verification when publisherName is missing. Require it in the
  // build-owned config, without replacing its verifier or inventing a publisher identity.
  try {
    if (!existsSync(config) || !hasPublisherIdentity(readFileSync(config, 'utf8'))) return { disabledReason: 'signing-unavailable' }
  } catch { return { disabledReason: 'signing-unavailable' } }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.forceDevUpdateConfig = false
  autoUpdater.disableWebInstaller = true
  autoUpdater.logger = null // The default logger can include URLs, local paths and raw errors.
  const updater = autoUpdater as NsisUpdater
  return { adapter: {
    async check() { const result = await updater.checkForUpdates(); return !!result?.isUpdateAvailable },
    async download() { await updater.downloadUpdate() },
    install() {
      // v6 quitAndInstall is void and can silently return without quitting. Observe its
      // public synchronous install:boolean result, preserving implementation and arguments.
      return observeInstall(updater)
    },
    onProgress(listener) { updater.on('download-progress', (event) => listener(event.percent)) },
    onError(listener) { updater.on('error', () => listener()) },
    onQuitCancelled(listener) {
      app.on('before-quit', (event) => { queueMicrotask(() => { if (event.defaultPrevented) listener() }) })
    },
  } }
}
