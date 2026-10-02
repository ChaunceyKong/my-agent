import { useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
const storageKey = 'agent-team-theme'

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(storageKey)
    if (value === 'light' || value === 'dark') return value
  } catch { /* Storage may be disabled; use the system preference. */ }
  return 'system'
}

function systemTheme(): 'light' | 'dark' {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference === 'system' ? systemTheme() : preference
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference)
  useEffect(() => {
    applyTheme(preference)
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const changed = () => applyTheme('system')
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [preference])
  function selectTheme(value: ThemePreference) {
    if (value !== 'light' && value !== 'dark' && value !== 'system') return
    try { window.localStorage.setItem(storageKey, value) } catch { /* Selection still applies for this session. */ }
    applyTheme(value)
    setPreference(value)
  }
  return { preference, selectTheme }
}
