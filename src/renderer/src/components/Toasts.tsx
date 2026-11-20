import type { ReactNode } from 'react'
import { CircleAlert, Info, X } from 'lucide-react'
import { useStore } from '../store'

export function Toasts(): ReactNode {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismiss)
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-default bg-surface-elevated px-3.5 py-3 text-sm shadow-lg"
        >
          {t.kind === 'error' ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-secondary" />
          )}
          <p className="selectable max-h-[40vh] min-w-0 flex-1 overflow-y-auto">{t.text}</p>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="text-tertiary hover:text-default"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
