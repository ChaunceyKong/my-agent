import { expect, it, vi } from 'vitest'
import { createWorkbenchStore } from './workbench-store'
import type { AgentTeamApi, Channel } from '../../shared/types'

const first: Channel = { id: 'c1', projectId: 'p', name: 'first', icon: null, speakerMode: 'automatic', maxTurns: 30, schedulerModelConfigId: null, createdAt: '', updatedAt: '' }
const second: Channel = { ...first, id: 'c2', name: 'second' }
const third: Channel = { ...first, id: 'c3', name: 'new' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function setup() {
  const api = {
    channels: { list: vi.fn().mockResolvedValue([first, second]), create: vi.fn().mockResolvedValue(third), remove: vi.fn().mockResolvedValue(undefined) },
    messages: { list: vi.fn().mockResolvedValue([]) }, tasks: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as AgentTeamApi
  return { api, store: createWorkbenchStore(api) }
}

it('keeps a confirmed newly created Channel and its selection when deletion refresh returns an older same-project list', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const refresh = deferred<Channel[]>()
  vi.mocked(api.channels.list).mockReturnValueOnce(refresh.promise)
  const removing = store.removeChannel(first.id)
  await vi.waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2))
  await store.createChannel('new')
  expect(store.getSnapshot().channelId).toBe(third.id)
  refresh.resolve([second]); await removing
  expect(store.getSnapshot().channels).toEqual([second, third])
  expect(store.getSnapshot().channelId).toBe(third.id)
})

it('keeps a confirmed Channel configuration and uses current fallback when deletion refresh is stale', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const refresh = deferred<Channel[]>()
  vi.mocked(api.channels.list).mockReturnValueOnce(refresh.promise)
  const removing = store.removeChannel(first.id)
  await vi.waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2))
  const configured = { ...second, speakerMode: 'manual' as const, maxTurns: 12 }
  store.updateChannel(configured)
  refresh.resolve([second]); await removing
  expect(store.getSnapshot().channels).toEqual([configured])
  expect(store.getSnapshot().channelId).toBe(second.id)
})

it('does not reinsert a second deleted Channel from an earlier pending deletion refresh', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const refresh = deferred<Channel[]>()
  vi.mocked(api.channels.list).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce([])
  const removing = store.removeChannel(first.id)
  await vi.waitFor(() => expect(api.channels.list).toHaveBeenCalledTimes(2))
  await store.removeChannel(second.id)
  refresh.resolve([second]); await removing
  expect(store.getSnapshot().channels).toEqual([])
  expect(store.getSnapshot().channelId).toBe('')
})

it('retains an explicitly switched Channel when a previously requested creation completes', async () => {
  const { api, store } = setup(); await store.selectProject('p')
  const creation = deferred<Channel>()
  vi.mocked(api.channels.create).mockReturnValueOnce(creation.promise)
  const creating = store.createChannel('new')
  await store.selectChannel(second.id)
  creation.resolve(third); await creating
  expect(store.getSnapshot().channels).toEqual([first, second, third])
  expect(store.getSnapshot().channelId).toBe(second.id)
})
