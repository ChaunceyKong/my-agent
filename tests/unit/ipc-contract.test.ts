import { IpcChannel } from '../../shared/ipc-channels'

it('defines only the v0.1 renderer-to-main commands', () => {
  expect(Object.values(IpcChannel)).toEqual(expect.arrayContaining([
    'project:create', 'project:list', 'channel:create', 'channel:list',
    'message:send', 'task-run:cancel', 'model:save', 'model:list',
  ]))
  expect(Object.values(IpcChannel)).not.toContain('tool:run')
})
