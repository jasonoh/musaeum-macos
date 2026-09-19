import { useCallback, useEffect, useState } from 'react'
import type { MetadataConflict, MetadataSource } from '@shared/metadata.types'
import { useUIStore } from '@/stores/ui.store'
import { CheckIcon, CloseIcon, SpinnerIcon } from '@/components/shared/icons'
import { ConflictResolver } from './ConflictResolver'

/** Review-queue modal: every unresolved metadata disagreement, per book. */
export function ConflictQueue() {
  const openModal = useUIStore((s) => s.openModal)
  const [conflicts, setConflicts] = useState<MetadataConflict[] | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  const refresh = useCallback(async () => {
    setConflicts(await window.Musaeum.metadata.getConflictQueue())
  }, [])

  useEffect(() => {
    // State is set after the IPC round-trip resolves, never synchronously
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().catch(console.error)
  }, [refresh])

  const sources = new Set<MetadataSource>()
  conflicts?.forEach((c) => c.candidates.forEach((cand) => sources.add(cand.source)))

  const acceptAllFrom = async (source: MetadataSource) => {
    if (!conflicts) return
    setBulkBusy(true)
    try {
      for (const c of conflicts) {
        if (c.candidates.some((cand) => cand.source === source)) {
          await window.Musaeum.metadata.resolveConflict(c.id, { [c.field]: source })
        }
      }
      await refresh()
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border border-ink-700 bg-ink-900 shadow-cover-lift">
        <div className="flex shrink-0 items-center justify-between border-b border-ink-800 px-5 py-3">
          <h2 className="font-display text-lg text-parchment">Metadata Review</h2>
          <button
            onClick={() => openModal(null)}
            className="rounded p-1 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
            aria-label="Close"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {conflicts && conflicts.length > 0 && sources.size > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-800 px-5 py-2.5">
            <span className="text-[12px] text-parchment-faint">Accept all from:</span>
            {[...sources].map((s) => (
              <button
                key={s}
                disabled={bulkBusy}
                onClick={() => void acceptAllFrom(s)}
                className="rounded-full border border-ink-600 px-2.5 py-0.5 text-[12px] text-parchment-dim hover:border-gold-500/60 hover:text-gold-300 disabled:opacity-50"
              >
                {s.replace('_', ' ')}
              </button>
            ))}
            {bulkBusy && <SpinnerIcon className="h-3.5 w-3.5 text-gold-400" />}
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {conflicts === null ? (
            <div className="flex justify-center py-10">
              <SpinnerIcon className="h-6 w-6 text-gold-400" />
            </div>
          ) : conflicts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-parchment-faint">
              <CheckIcon className="h-8 w-8 text-gold-400" />
              <p className="text-sm">All metadata reviewed — nothing needs attention</p>
            </div>
          ) : (
            conflicts.map((c) => (
              <ConflictResolver key={c.id} conflict={c} onResolved={() => void refresh()} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
