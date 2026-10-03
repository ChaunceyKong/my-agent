import type { DiagnosticCode } from './diagnostics'

/** Fatal failures never continue with unknown in-flight effects. */
export function createFatalHandler(deps: {
  record(code: DiagnosticCode): void
  showError(): void
  exit(): void
}) {
  let exiting = false
  return (code: DiagnosticCode) => {
    if (exiting) return
    exiting = true
    try { deps.record(code) } catch { /* Do not recurse on logging failure. */ }
    try { deps.showError() } catch { /* Even a failed dialog must exit. */ }
    finally { deps.exit() }
  }
}
