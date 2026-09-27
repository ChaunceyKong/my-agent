import { expect, it, vi } from 'vitest'
import { createSingleAgentRunner, parseToolEnvelope } from '../../electron/core/single-agent-runner'

const agent = { id: 'a', name: 'A', avatar: null, title: '', systemPrompt: '', modelConfigId: 'm', defaultToolPermissions: { read_file: true }, isBuiltin: false, createdAt: '', updatedAt: '' }
function setup(replies: string[], execution: { status: string; resultSummary: string | null } = { status: 'completed', resultSummary: '已读取文件' }) {
  let index = 0
  const repositories: any = { listChannelAgents: vi.fn().mockResolvedValue([{ agentId: 'a', isEnabled: true, modelConfigOverrideId: null }]), getAgent: vi.fn().mockResolvedValue(agent), getTaskRun: vi.fn().mockResolvedValue({ id: 'r', status: 'running', generation: 0 }), listMessages: vi.fn().mockResolvedValue([]), transitionTaskRun: vi.fn().mockResolvedValue({}) }
  const modelClient: any = { streamChat: vi.fn(async (_input: any, emit: any) => { await emit({ taskRunId: 'r', type: 'delta', content: replies[index++] }); await emit({ taskRunId: 'r', type: 'complete' }) }) }
  const taskRuns: any = { canAcceptChunk: vi.fn().mockResolvedValue(true), finishTaskRun: vi.fn().mockResolvedValue({}) }
  const toolEngine: any = { execute: vi.fn().mockResolvedValue({ execution }) }
  return { runner: createSingleAgentRunner({ repositories, modelClient, taskRuns, toolEngine }), repositories, modelClient, taskRuns, toolEngine }
}

it('only accepts an exact JSON tool envelope', () => {
  expect(parseToolEnvelope('{"tool":{"toolName":"read_file","input":{"path":"a.md"}}}')).toMatchObject({ toolName: 'read_file' })
  expect(parseToolEnvelope('please {"tool":{}}')).toBeUndefined()
  expect(parseToolEnvelope('{"tool":{},"text":"x"}')).toBeUndefined()
})

it('executes a safe tool then completes with the follow-up response', async () => {
  const { runner, toolEngine, taskRuns } = setup(['{"tool":{"toolName":"read_file","input":{"path":"a.md"}}}', '完成'])
  const events: any[] = []
  await runner.run({ taskRunId: 'r', projectId: 'p', channelId: 'c', active: { agent, modelConfigId: 'm' }, onEvent: async (event) => { events.push(event) } })
  expect(toolEngine.execute).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', generation: 0 }), expect.objectContaining({ toolName: 'read_file' }))
  expect(taskRuns.finishTaskRun).toHaveBeenCalledWith('r', '完成')
  expect(events).toEqual([{ taskRunId: 'r', type: 'complete' }])
})

it('fails safe at the maximum tool step count', async () => {
  const tool = '{"tool":{"toolName":"read_file","input":{"path":"a.md"}}}'
  const { runner, repositories } = setup([tool, tool, tool, tool, tool])
  const events: any[] = []
  await runner.run({ taskRunId: 'r', projectId: 'p', channelId: 'c', active: { agent, modelConfigId: 'm' }, onEvent: async (event) => { events.push(event) } })
  expect(repositories.transitionTaskRun).toHaveBeenCalledWith('r', 'running', 'failed', expect.objectContaining({ errorMessage: expect.stringContaining('上限') }))
  expect(events.at(-1)).toMatchObject({ type: 'error' })
})

it('stops at pending approval without another model call', async () => {
  const { runner, modelClient } = setup(['{"tool":{"toolName":"write_file","input":{"path":"a.md","content":"x"}}}'], { status: 'waiting_approval', resultSummary: '等待 CEO 审批' })
  const events: any[] = []
  await runner.run({ taskRunId: 'r', projectId: 'p', channelId: 'c', active: { agent, modelConfigId: 'm' }, onEvent: async (event) => { events.push(event) } })
  expect(modelClient.streamChat).toHaveBeenCalledTimes(1)
  expect(events).toEqual([expect.objectContaining({ type: 'error', content: expect.stringContaining('等待 CEO 审批') })])
})

it('returns a safe rejection summary to the next model step', async () => {
  const { runner, modelClient, taskRuns } = setup([
    '{"tool":{"toolName":"write_file","input":{"path":"a.md","content":"x"}}}', '已改用安全方案',
  ], { status: 'cancelled', resultSummary: '审批未通过或已失效' })
  await runner.run({ taskRunId: 'r', projectId: 'p', channelId: 'c', active: { agent, modelConfigId: 'm' }, onEvent: async () => {} })
  expect(modelClient.streamChat).toHaveBeenCalledTimes(2)
  expect(modelClient.streamChat.mock.calls[1][0].messages.at(-1).content).toContain('审批未通过或已失效')
  expect(taskRuns.finishTaskRun).toHaveBeenCalledWith('r', '已改用安全方案')
})
