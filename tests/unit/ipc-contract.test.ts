import { IpcChannel } from '../../shared/ipc-channels'

it('defines exactly the v0.1 IPC channels', () => {
  expect(Object.values(IpcChannel)).toEqual([
    'project:create', 'project:list', 'channel:create', 'channel:list',
    'message:send', 'task-run:cancel', 'model:save', 'model:list',
    'message:stream', 'message:list', 'task-run:list', 'cloud-consent:has', 'cloud-consent:grant',
  ])
})
