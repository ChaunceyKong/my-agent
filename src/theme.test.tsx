// @vitest-environment jsdom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppHeader } from './components/layout/AppHeader'
import { applyTheme, readThemePreference } from './theme'

let dark = false
let listeners: Set<() => void>
beforeEach(() => {
  localStorage.clear()
  dark = false
  listeners = new Set()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return dark },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme })
function header() { return render(<AppHeader cockpitOpen onToggle={() => {}} />) }
function systemChange(value: boolean) { act(() => { dark = value; for (const listener of listeners) listener() }) }

it('defaults to system without a project and follows live changes', () => {
  header()
  expect(screen.getByLabelText('界面主题')).toHaveValue('system')
  expect(document.documentElement.dataset.theme).toBe('light')
  systemChange(true)
  expect(document.documentElement.dataset.theme).toBe('dark')
  systemChange(false)
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('persists explicit choices, ignores system changes and restores the preference', () => {
  const view = header()
  fireEvent.change(screen.getByLabelText('界面主题'), { target: { value: 'dark' } })
  expect(localStorage.getItem('agent-team-theme')).toBe('dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(listeners.size).toBe(0)
  systemChange(false)
  expect(document.documentElement.dataset.theme).toBe('dark')
  view.unmount()
  header()
  expect(screen.getByLabelText('界面主题')).toHaveValue('dark')
  fireEvent.change(screen.getByLabelText('界面主题'), { target: { value: 'light' } })
  expect(localStorage.getItem('agent-team-theme')).toBe('light')
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('returning to system persists the choice and resumes live changes', () => {
  localStorage.setItem('agent-team-theme', 'light')
  header()
  dark = true
  fireEvent.change(screen.getByLabelText('界面主题'), { target: { value: 'system' } })
  expect(localStorage.getItem('agent-team-theme')).toBe('system')
  expect(document.documentElement.dataset.theme).toBe('dark')
  systemChange(false)
  expect(document.documentElement.dataset.theme).toBe('light')
})

it.each(['invalid', 'Dark', '', '{"theme":"dark"}'])('rejects an invalid persisted preference %j before rendering', (value) => {
  localStorage.setItem('agent-team-theme', value)
  dark = true
  expect(readThemePreference()).toBe('system')
  applyTheme(readThemePreference())
  expect(document.documentElement.dataset.theme).toBe('dark')
})

it('tolerates unavailable storage and still applies the selected theme', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  header()
  expect(screen.getByLabelText('界面主题')).toHaveValue('system')
  fireEvent.change(screen.getByLabelText('界面主题'), { target: { value: 'dark' } })
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(screen.getByLabelText('界面主题')).toHaveValue('dark')
})

it('falls back to light when matchMedia is unavailable', () => {
  vi.stubGlobal('matchMedia', undefined)
  applyTheme('system')
  header()
  expect(document.documentElement.dataset.theme).toBe('light')
  fireEvent.change(screen.getByLabelText('界面主题'), { target: { value: 'dark' } })
  expect(document.documentElement.dataset.theme).toBe('dark')
})

it('disposes system listeners under StrictMode and on unmount', () => {
  const view = render(<StrictMode><AppHeader cockpitOpen onToggle={() => {}} /></StrictMode>)
  expect(listeners.size).toBe(1)
  view.unmount()
  expect(listeners.size).toBe(0)
})
