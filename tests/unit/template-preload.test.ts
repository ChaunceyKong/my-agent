import { expect, it, vi } from 'vitest'
import type { AgentTeamApi } from '../../shared/types'

const electron = vi.hoisted(() => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn() } }))
vi.mock('electron', () => electron)

it('exposes only the four named template operations without a generic IPC or local authority', async () => {
  await import('../../electron/preload')
  const [name, api] = electron.contextBridge.exposeInMainWorld.mock.calls[0] as [string, AgentTeamApi]
  expect(name).toBe('agentTeam')
  expect(Object.keys(api.templates)).toEqual(['list', 'get', 'importTeam', 'copyAgent'])
  const input = { templateId: 'media', channelId: 'c', modelConfigId: 'm' }
  const copy = { templateId: 'media', roleId: 'editor', channelId: 'c', editor: { name: 'Editor', avatar: null, title: '', systemPrompt: '', modelConfigId: 'm' } }
  await api.templates.list(); await api.templates.get('media'); await api.templates.importTeam(input); await api.templates.copyAgent(copy)
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    ['template:list'], ['template:get', 'media'], ['template:import', input], ['template:copy', copy],
  ])
  expect(api).not.toHaveProperty('invoke')
  for (const key of ['fs', 'process', 'shell', 'database', 'credentials']) expect(api).not.toHaveProperty(key)
})
