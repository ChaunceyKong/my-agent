import { IpcChannel } from '../../shared/ipc-channels'

it('defines exactly the named IPC channels', () => {
  expect(Object.values(IpcChannel)).toEqual([
    'project:create', 'project:list', 'project:pick-workspace', 'channel:create', 'channel:list', 'channel:set-scheduler',
    'message:send', 'task-run:cancel', 'task-run:continue', 'task-run:assign', 'task-run:terminate', 'task-run:interrupt', 'task-run:acknowledge-process-recovery', 'model:save', 'model:list',
    'model:remove', 'model:test', 'model:discover', 'model:default-get', 'model:default-set',
    'message:stream', 'message:list', 'task-run:list', 'cloud-consent:has', 'cloud-consent:grant',
    'agent:list', 'agent:get', 'agent:create', 'agent:update', 'agent:remove',
    'channel-agent:list', 'channel-agent:save', 'channel-agent:remove',
    'approval:approve', 'approval:reject', 'approval:expire', 'approval:run-approved',
    'executable:list', 'executable:save',
    'tool-execution:list', 'approval:list', 'workspace:list',
  ])
  expect(Object.values(IpcChannel).some((channel) => /^(fs|process|shell|database|credential):/i.test(channel))).toBe(false)
})
