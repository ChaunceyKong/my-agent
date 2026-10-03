// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it } from 'vitest'
import { MessageStream } from './MessageStream'
import { emptyConversation } from '../../stores/workbench-store'

afterEach(cleanup)
it('uses durable actual IDs only for completed replies and distinguishes attempt facts from success', () => {
  render(<MessageStream models={[{ id: 'backup', modelName: 'renamed', providerPreset: 'openai', baseUrl: 'https://example.test', hasApiKey: true }]} conversation={{ ...emptyConversation,
    messages: [{ id: 'reply', channelId: 'c', taskRunId: 'r', agentId: null, origin: 'legacy', taskRunSeq: null, role: 'agent', authorName: 'AI', content: 'done', status: 'completed', createdAt: '', actualModelConfigId: 'backup' },
      { id: 'failed', channelId: 'c', taskRunId: 'r', agentId: null, origin: 'legacy', taskRunSeq: null, role: 'agent', authorName: 'AI', content: 'partial', status: 'failed', createdAt: '', actualModelConfigId: 'primary' }],
    events: [{ id: 'e', taskRunId: 'r', seq: 1, generation: 0, eventType: 'model_switched', agentId: null, messageId: null, toolExecutionId: null, displayReason: '开始尝试备选模型', createdAt: '' }],
  }} />)
  expect(screen.getByText(/实际完成模型配置：backup/)).toHaveTextContent('当前名称：renamed')
  expect(screen.queryByText(/实际完成模型配置：primary/)).toBeNull()
  expect(screen.getByText(/开始尝试备选模型/)).toHaveTextContent('尝试记录，非完成结果')
  expect(screen.getAllByRole('article')).toHaveLength(2)
})
