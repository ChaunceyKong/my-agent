// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
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

it('renders Agent Markdown headings, emphasis, lists, GFM tables and literal code while preserving CEO text', () => {
  const markdown = '# 团队成员\n\n**两位 Agent**\n\n- 作者\n- 审核\n\n| 成员 | 角色 |\n| --- | --- |\n| 作者 | 写作 |\n\n```js\nconst sample = "<script>test</script>"\n```'
  render(<MessageStream conversation={{ ...emptyConversation, messages: [
    { id: 'ceo', channelId: 'c', taskRunId: 'r', agentId: null, taskRunSeq: null, origin: 'ceo', role: 'ceo', authorName: 'CEO', content: '**用户原文**', status: 'sent', createdAt: '1' },
    { id: 'agent', channelId: 'c', taskRunId: 'r', agentId: 'a', taskRunSeq: 1, origin: 'agent', role: 'agent', authorName: '作者', content: markdown, status: 'completed', createdAt: '2' },
  ] }} />)
  const reply = screen.getAllByRole('article')[1]
  expect(within(reply).getByRole('heading', { name: '团队成员', level: 1 })).toBeVisible()
  expect(within(reply).getByText('两位 Agent').tagName).toBe('STRONG')
  expect(within(reply).getAllByRole('listitem')).toHaveLength(2)
  expect(within(reply).getByRole('table')).toHaveTextContent('作者写作')
  expect(reply.querySelector('pre code')).toHaveTextContent('const sample = "<script>test</script>"')
  expect(reply.querySelector('script')).toBeNull()
  expect(screen.getByText('**用户原文**')).toBeVisible()
})

it('renders stream updates and ignores raw HTML, executable links and automatic image loads', () => {
  const preview = { id: 'preview', channelId: 'c', taskRunId: 'r', agentId: 'a', taskRunSeq: 1, origin: 'agent' as const, role: 'agent' as const, authorName: '作者', content: '**正在', status: 'streaming' as const, createdAt: '' }
  const view = render(<MessageStream conversation={{ ...emptyConversation, previews: [preview] }} />)
  view.rerender(<MessageStream conversation={{ ...emptyConversation, previews: [{ ...preview, content: '**正在生成**\n\n<script>window.pwned = true</script>\n\n<img src="https://example.test/tracker" onerror="alert(1)">\n\n[危险链接](javascript:alert%281%29)\n\n![图示](https://example.test/image.png)' }] }} />)
  expect(screen.getByText('正在生成', { selector: 'strong' })).toBeVisible()
  expect(document.querySelector('script, img, [onerror]')).toBeNull()
  expect(screen.getByText('危险链接')).not.toHaveAttribute('href')
  expect(screen.getByText('[图片：图示]')).toBeVisible()
})
