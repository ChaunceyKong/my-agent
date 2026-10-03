import { expect, it, vi } from 'vitest'
import type { AgentTeamApi } from '../../shared/types'

const electron = vi.hoisted(() => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn() } }))
vi.mock('electron', () => electron)

it('exposes exactly fixed-code reporting and pathless diagnostic export', async () => {
  await import('../../electron/preload')
  const [, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AgentTeamApi]
  expect(Object.keys(api.diagnostics)).toEqual(['report', 'export'])
  await api.diagnostics.report('renderer_render_failed')
  await api.diagnostics.export()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([['diagnostics:report', 'renderer_render_failed'], ['diagnostics:export']])
  for (const key of ['invoke', 'fs', 'shell', 'readLogs', 'logPath']) expect(api).not.toHaveProperty(key)
})
