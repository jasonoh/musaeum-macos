import { useUIStore, type Toast, type ToastKind } from '@/stores/ui.store'
import { CheckIcon, CloseIcon, InfoIcon, WarningIcon } from '@/components/shared/icons'

const TONE: Record<ToastKind, { border: string; icon: string }> = {
  success: { border: 'border-gold-500/30', icon: 'text-gold-400' },
  info: { border: 'border-ink-600', icon: 'text-parchment-faint' },
  error: { border: 'border-red-500/40', icon: 'text-red-400' }
}

function ToastIcon({ kind, className }: { kind: ToastKind; className: string }) {
  if (kind === 'error') return <WarningIcon className={className} />
  if (kind === 'info') return <InfoIcon className={className} />
  return <CheckIcon className={className} />
}

function ToastCard({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const tone = TONE[toast.kind]

  return (
    <div
      // An error deserves announcing; a "nothing changed" report does not
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex w-[380px] animate-slide-up items-start gap-2.5 rounded-lg border bg-ink-850/95 px-3.5 py-2.5 shadow-cover-lift backdrop-blur-sm ${tone.border}`}
    >
      <ToastIcon kind={toast.kind} className={`mt-0.5 h-4 w-4 shrink-0 ${tone.icon}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5 text-parchment">{toast.message}</p>
        {toast.detail && (
          <p className="mt-0.5 text-[11.5px] leading-4 text-parchment-dim">{toast.detail}</p>
        )}
        {toast.action && (
          <button
            onClick={() => {
              toast.action?.run()
              dismiss(toast.id)
            }}
            className="mt-1.5 rounded border border-gold-500/40 px-2 py-0.5 text-[11px] font-semibold text-gold-300 hover:border-gold-500 hover:bg-gold-500/10"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
      >
        <CloseIcon className="h-3 w-3" />
      </button>
    </div>
  )
}

/**
 * The report surface for work that finishes out of sight. Mounted once at app
 * root; nothing else renders one.
 *
 * Above the modals (`z-50`) because it is *the* completion report for jobs the
 * user started before opening something else — a refresh that finishes while a
 * settings panel is up must not be hidden behind it. Anchored bottom-centre
 * rather than bottom-right so it never covers the detail panel's action row,
 * which is where these are usually triggered from. Dismissal is the store's
 * (see `notify`), so the timer and the close button can't disagree.
 */
export function Toasts() {
  const toasts = useUIStore((s) => s.toasts)
  const dismissToast = useUIStore((s) => s.dismissToast)
  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-9 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} dismiss={dismissToast} />
      ))}
    </div>
  )
}
