import { IpcChannel } from '../../shared/ipc-channels'

it('defines exactly the named IPC channels', () => {
  expect(Object.values(IpcChannel)).toEqual([
    'project:create', 'project:list', 'project:pick-workspace', 'channel:create', 'channel:list',
    'message:send', 'task-run:cancel', 'model:save', 'model:list',
    'message:stream', 'message:list', 'task-run:list', 'cloud-consent:has', 'cloud-consent:grant',
    'agent:list', 'agent:get', 'agent:create', 'agent:update', 'agent:remove',
    'channel-agent:list', 'channel-agent:save', 'channel-agent:remove',
    'approval:approve', 'approval:reject', 'approval:expire', 'approval:run-approved',
    'executable:list', 'executable:save',
  ])
})
