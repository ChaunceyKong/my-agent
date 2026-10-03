import { expect, it, vi } from 'vitest'
import type { AgentTeamApi } from '../../shared/types'
const electron = vi.hoisted(() => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn() } }))
vi.mock('electron', () => electron)
it('exposes only five no-argument update actions without feed or path access', async () => {
  await import('../../electron/preload')
  const [, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AgentTeamApi]
  expect(Object.keys(api.updates)).toEqual(['status', 'check', 'download', 'install', 'cancel'])
  for (const action of Object.values(api.updates)) await action()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual(['status', 'check', 'download', 'install', 'cancel'].map((name) => [`update:${name}`]))
  expect(api.updates).not.toHaveProperty('setFeedURL')
})
