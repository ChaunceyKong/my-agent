import { useEffect, useId, useRef } from 'react'

export function Dialog({ title, children, onClose, busy = false }: { title: string; children: React.ReactNode; onClose(): void; busy?: boolean }) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus()
    return () => previous?.focus()
  }, [])
  return <div className="modal-backdrop"><div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose() }
    if (event.key === 'Tab') {
      const focusable = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
      if (!focusable?.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }}><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}>×</button></div>{children}</div></div>
}
