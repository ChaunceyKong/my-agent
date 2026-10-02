// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentTeamApi } from '../../../shared/types'
import { SettingsDialog } from './SettingsDialog'

afterEach(cleanup)
it('edits and clears a fallback, excludes self and resets the selection for a new config', async () => {
  window.agentTeam = { models: { list: vi.fn().mockResolvedValue([
    { id: 'primary', modelName: 'primary', providerPreset: 'openai', baseUrl: 'https://example.test', hasApiKey: true, fallbackConfigId: 'backup' },
    { id: 'backup', modelName: 'backup', providerPreset: 'openai', baseUrl: 'https://backup.test', hasApiKey: true },
  ]), getDefaultScheduler: vi.fn().mockResolvedValue(null) } } as unknown as AgentTeamApi
  const save = vi.fn().mockResolvedValue(undefined)
  render(<SettingsDialog onSave={save} onClose={() => {}} />)
  await waitFor(() => expect(screen.getByLabelText('已有配置').querySelectorAll('option')).toHaveLength(3))
  await userEvent.selectOptions(screen.getByLabelText('已有配置'), 'primary')
  expect(screen.getByLabelText('备选模型')).toHaveValue('backup')
  expect(screen.getByLabelText('备选模型').querySelector('option[value="primary"]')).toBeNull()
  await userEvent.selectOptions(screen.getByLabelText('备选模型'), '')
  await userEvent.click(screen.getByRole('button', { name: '保存配置' }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: 'primary', fallbackConfigId: null, apiKey: '' }))
  await userEvent.selectOptions(screen.getByLabelText('已有配置'), 'primary')
  await userEvent.selectOptions(screen.getByLabelText('已有配置'), '')
  expect(screen.getByLabelText('备选模型')).toHaveValue('')
})
