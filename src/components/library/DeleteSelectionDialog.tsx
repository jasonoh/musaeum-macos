import { useEffect, useMemo, useState } from 'react'
import type { BulkDeleteResult } from '@shared/api.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { SpinnerIcon, TrashIcon } from '@/components/shared/icons'

const PREVIEW_TITLES = 5

/**
 * Confirmation for deleting many books. Whole books only — a per-format
 * picker across a mixed selection has no coherent meaning.
 */
export function DeleteSelectionDialog() {
  const requestSelectionDelete = useUIStore((s) => s.requestSelectionDelete)
  const selectedIds = useUIStore((s) => s.selection.ids)
  const clearSelection = useUIStore((s) => s.clearSelection)
  const selectBook = useUIStore((s) => s.selectBook)
  const books = useLibraryStore((s) => s.books)
  const online = useNASStore((s) => s.status?.state === 'connected')

  const selected = useMemo(() => books.filter((b) => selectedIds.has(b.id)), [books, selectedIds])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkDeleteResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) requestSelectionDelete(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestSelectionDelete, busy])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.Musaeum.library.deleteBooks(selected.map((b) => b.id))
      if (res.failed.length === 0) {
        // Deleted books must not stay selected, and waiting for the library
        // reload's prune would depend on broadcast timing
        clearSelection()
        requestSelectionDelete(false)
        return
      }
      // Keep the survivors selected so the report doubles as the retry
      setResult(res)
      if (res.failed.length === 1) selectBook(res.failed[0].id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && requestSelectionDelete(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${selected.length} books`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">
          Delete {selected.length} books?
        </h2>

        <ul className="mt-3 space-y-1">
          {selected.slice(0, PREVIEW_TITLES).map((b) => (
            <li key={b.id} className="truncate text-[13px] text-parchment-dim">
              {b.title}
            </li>
          ))}
          {selected.length > PREVIEW_TITLES && (
            <li className="text-[12px] text-parchment-faint">
              +{selected.length - PREVIEW_TITLES} more
            </li>
          )}
        </ul>

        <p className="mt-4 text-[12px] leading-relaxed text-parchment-dim">
          This permanently removes each book, all of its files, covers, and metadata from the
          library. This can’t be undone.
        </p>

        {!online && (
          <p className="mt-3 text-[12px] text-danger-400">
            The library is offline — reconnect before deleting.
          </p>
        )}
        {error && <p className="mt-3 text-[12px] text-danger-400">{error}</p>}
        {result && (
          <div className="mt-3 rounded-md border border-danger-500/40 bg-danger-500/10 p-3">
            <p className="text-[12px] text-parchment-dim">
              Deleted {result.deleted}. {result.failed.length} could not be deleted and are still
              selected:
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {result.failed.map((f) => (
                <li key={f.id} className="truncate text-[12px] text-danger-400">
                  {f.title} — {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => requestSelectionDelete(false)}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              disabled={busy || !online || selected.length === 0}
              onClick={() => void confirm()}
              className="flex items-center gap-2 rounded-md bg-danger-500 px-3 py-1.5 text-[13px] font-semibold text-on-danger hover:bg-danger-500/90 disabled:opacity-40"
            >
              {busy ? <SpinnerIcon className="h-4 w-4" /> : <TrashIcon className="h-4 w-4" />}
              Delete {selected.length} books
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
