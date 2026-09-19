import { useLibraryStore } from '@/stores/library.store'
import { useDeviceStore } from '@/stores/device.store'
import { useUIStore } from '@/stores/ui.store'
import { SpinnerIcon } from '@/components/shared/icons'

export function StatusBar() {
  const books = useLibraryStore((s) => s.books)
  const loading = useLibraryStore((s) => s.loading)
  const query = useLibraryStore((s) => s.query)
  const filters = useLibraryStore((s) => s.filters)
  const importJobs = useLibraryStore((s) => s.importJobs)
  const transfers = useDeviceStore((s) => s.transfers)
  const bulkHydrate = useLibraryStore((s) => s.bulkHydrate)
  const pythonEnv = useUIStore((s) => s.pythonEnv)

  const activeImports = Object.values(importJobs).filter(
    (j) => j.step !== 'done' && j.step !== 'error'
  ).length
  const activeTransfers = Object.values(transfers).filter(
    (t) => t.status !== 'done' && t.status !== 'error'
  ).length
  const filtered = query.trim() || Object.keys(filters).length > 0

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-ink-800 bg-ink-900 px-4 text-[11px] text-parchment-faint">
      <span className="tabular-nums">
        {books.length} {books.length === 1 ? 'book' : 'books'}
        {filtered && ' shown'}
      </span>
      {activeImports > 0 && (
        <span className="flex items-center gap-1.5 text-gold-400">
          <SpinnerIcon className="h-3 w-3" />
          Importing {activeImports}…
        </span>
      )}
      {activeTransfers > 0 && (
        <span className="flex items-center gap-1.5 text-gold-400">
          <SpinnerIcon className="h-3 w-3" />
          Sending {activeTransfers} to device…
        </span>
      )}
      {bulkHydrate && (
        <span className="flex items-center gap-1.5 text-gold-400">
          <SpinnerIcon className="h-3 w-3" />
          <span className="tabular-nums">
            Refreshing metadata {bulkHydrate.completed}/{bulkHydrate.total}…
          </span>
          {/* Cancel lives here, not in the selection panel: the job outlives
              the selection, and clearing the selection must never strand a
              running job with no way to stop it. */}
          <button
            onClick={() => void window.Musaeum.metadata.cancelRehydrate()}
            className="underline underline-offset-2 hover:text-gold-300"
          >
            Cancel
          </button>
        </span>
      )}
      {/* First launch only: the packaged app builds its Python environment
          before metadata features work. `title` carries the detail — pip's
          failure line is far too long for a 28px bar. */}
      {pythonEnv && (
        <span
          title={pythonEnv.detail}
          className={
            pythonEnv.stage === 'failed'
              ? 'flex items-center gap-1.5 text-danger-400'
              : 'flex items-center gap-1.5 text-gold-400'
          }
        >
          {pythonEnv.stage !== 'failed' && <SpinnerIcon className="h-3 w-3" />}
          {pythonEnv.message}
        </span>
      )}
      {loading && <span className="ml-auto">Loading…</span>}
    </footer>
  )
}
