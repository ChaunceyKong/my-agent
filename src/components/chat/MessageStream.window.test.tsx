// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Message } from '../../../shared/types'
import { MessageStream } from './MessageStream'
import { emptyConversation } from '../../stores/workbench-store'

const message = (index: number, content = `message ${index}`): Message => ({ id: `m${index}`, channelId: 'c', taskRunId: null, agentId: null, origin: 'legacy', taskRunSeq: null, role: 'agent', authorName: 'Author', content, status: 'completed', createdAt: '' })
let heights: Map<string, number>
let observers: Array<{ callback(): void; disconnect: ReturnType<typeof vi.fn> }>
let viewportHeight: number
const descriptors = new Map<string, PropertyDescriptor | undefined>()

beforeEach(() => {
  heights = new Map()
  viewportHeight = 200
  observers = []
  const positions = new WeakMap<HTMLElement, number>()
  for (const property of ['clientHeight', 'scrollHeight', 'scrollTop']) descriptors.set(property, Object.getOwnPropertyDescriptor(HTMLElement.prototype, property))
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => viewportHeight })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) {
    return [...this.children].reduce((sum, child) => sum + (child.hasAttribute('data-history-row') ? heights.get((child as HTMLElement).dataset.historyRow!) ?? 100 : parseFloat((child as HTMLElement).style.height) || 0), 0)
  } })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', { configurable: true, get(this: HTMLElement) { return positions.get(this) ?? 0 }, set(this: HTMLElement, value: number) { positions.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))) } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const height = heights.get(this.dataset.historyRow!) ?? 100
    let top = 0
    if (this.parentElement?.getAttribute('role') === 'log') {
      for (const sibling of this.parentElement.children) {
        if (sibling === this) break
        top += sibling.hasAttribute('data-history-row') ? heights.get((sibling as HTMLElement).dataset.historyRow!) ?? 100 : parseFloat((sibling as HTMLElement).style.height) || 0
      }
      top -= this.parentElement.scrollTop
    }
    return { height, width: 600, top, bottom: top + height, left: 0, right: 600, x: 0, y: top, toJSON: () => ({}) }
  })
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    constructor(callback: () => void) { observers.push({ callback, disconnect: this.disconnect }) }
    observe() {}
  })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const [property, descriptor] of descriptors) { if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property] }
  descriptors.clear()
})

it('bounds all message, attempt and run rows while earliest and latest remain accessible', () => {
  const conversation = { ...emptyConversation, messages: Array.from({ length: 500 }, (_, index) => message(index)),
    events: Array.from({ length: 500 }, (_, index) => ({ id: `e${index}`, taskRunId: 'r', seq: index, generation: 0, eventType: 'model_attempt' as const, agentId: null, messageId: null, toolExecutionId: null, displayReason: `attempt ${index}`, createdAt: '' })),
    runs: Array.from({ length: 500 }, (_, index) => ({ id: `r${index}`, channelId: 'c', modelConfigId: 'model', status: 'completed' as const, generation: 0, currentTurnId: null, turnCount: 0, pauseReason: null, createdAt: '', startedAt: null, finishedAt: null, errorMessage: null })) }
  render(<MessageStream conversation={conversation} />)
  const log = screen.getByRole('log')
  expect(log.querySelectorAll('[data-history-row]').length).toBeLessThanOrEqual(80)
  expect(log.querySelector('[data-history-row="run:r499"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '最早记录' }))
  expect(screen.getByText('message 0')).toBeVisible()
  expect(log.querySelectorAll('[data-history-row]').length).toBeLessThanOrEqual(80)
  fireEvent.click(screen.getByRole('button', { name: '最新记录' }))
  expect(log.querySelector('[data-history-row="run:r499"]')).not.toBeNull()
})

it('preserves the read row and pixel offset when measured heights above it change', () => {
  const conversation = { ...emptyConversation, messages: Array.from({ length: 50 }, (_, index) => message(index)) }
  const view = render(<MessageStream conversation={conversation} />)
  const log = screen.getByRole('log')
  fireEvent.click(screen.getByRole('button', { name: '最早记录' }))
  log.scrollTop = 350; fireEvent.scroll(log)
  const row = log.querySelector<HTMLElement>('[data-history-row="message:m3"]')!
  const offset = row.getBoundingClientRect().top
  heights.set('message:m0', 350)
  act(() => observers.at(-1)!.callback())
  expect(row.getBoundingClientRect().top).toBe(offset)
  const readingTop = log.scrollTop
  view.rerender(<MessageStream conversation={{ ...conversation, previews: [{ ...message(51, 'new token'), status: 'streaming' }] }} />)
  expect(log.scrollTop).toBe(readingTop)
  expect(log).toHaveAttribute('aria-live', 'off')
})

it('follows new output only near bottom and never truncates an oversized bubble', () => {
  const conversation = { ...emptyConversation, messages: Array.from({ length: 30 }, (_, index) => message(index)) }
  const view = render(<MessageStream conversation={conversation} />)
  const log = screen.getByRole('log')
  log.scrollTop = log.scrollHeight - log.clientHeight - 50; fireEvent.scroll(log)
  const long = 'full content\n'.repeat(300)
  heights.set('message:m31', 3000)
  view.rerender(<MessageStream conversation={{ ...conversation, previews: [{ ...message(31, long), status: 'streaming' }] }} />)
  expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBe(0)
  expect(log.querySelector('.message-bubble')?.parentElement).not.toBeNull()
  expect(log.querySelector('[data-history-row="message:m31"] .message-bubble')!.textContent).toBe(long)
  expect(log.querySelector('[data-history-row="message:m31"]')!.getBoundingClientRect().height).toBe(3000)
})

it('replaces streaming preview with one durable actual-model reply', () => {
  const preview = { ...message(1, 'unique answer'), status: 'streaming' as const }
  const view = render(<MessageStream conversation={{ ...emptyConversation, previews: [preview] }} />)
  expect(screen.queryByText(/实际完成模型/)).toBeNull()
  view.rerender(<MessageStream conversation={{ ...emptyConversation, previews: [], messages: [{ ...preview, id: 'durable', status: 'completed', actualModelConfigId: 'actual' }] }} />)
  expect(screen.getAllByText('unique answer')).toHaveLength(1)
  expect(screen.getByText(/实际完成模型配置：actual/)).toBeVisible()
})

it('reacts to pure viewport height changes immediately without awaiting a snapshot poll', () => {
  render(<MessageStream conversation={{ ...emptyConversation, messages: Array.from({ length: 50 }, (_, index) => message(index)) }} />)
  const log = screen.getByRole('log')
  viewportHeight = 100
  act(() => observers.at(-1)!.callback())
  expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: '最早记录' }))
  log.scrollTop = 350; fireEvent.scroll(log)
  const offset = log.querySelector('[data-history-row="message:m3"]')!.getBoundingClientRect().top
  viewportHeight = 300
  act(() => observers.at(-1)!.callback())
  expect(log.querySelector('[data-history-row="message:m3"]')!.getBoundingClientRect().top).toBe(offset)
  log.style.paddingTop = '26px'
  fireEvent.click(screen.getByRole('button', { name: '最早记录' }))
  viewportHeight = 350
  act(() => observers.at(-1)!.callback())
  expect(log.scrollTop).toBe(0)
})

it('disposes observers under StrictMode and resets history position across keyed channels', () => {
  const view = render(<StrictMode><MessageStream key="c1" conversation={{ ...emptyConversation, messages: Array.from({ length: 50 }, (_, index) => message(index)) }} /></StrictMode>)
  fireEvent.click(screen.getByRole('button', { name: '最早记录' }))
  view.rerender(<StrictMode><MessageStream key="c2" conversation={{ ...emptyConversation, messages: [message(100)] }} /></StrictMode>)
  expect(screen.getByText('message 100')).toBeVisible()
  expect(screen.queryByText('message 0')).toBeNull()
  view.unmount()
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true)
})
