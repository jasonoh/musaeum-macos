import { useEffect } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { describeBulkHydrate } from '@/lib/metadata-feedback'

/** Wire the library store to main-process events. Mount once at app root. */
export function useLibrary(): void {
  const load = useLibraryStore((s) => s.load)
  const upsertImportJob = useLibraryStore((s) => s.upsertImportJob)
  const removeImportJob = useLibraryStore((s) => s.removeImportJob)
  const setRebuildProgress = useLibraryStore((s) => s.setRebuildProgress)
  const setBulkHydrate = useLibraryStore((s) => s.setBulkHydrate)
  const setConflictCount = useUIStore((s) => s.setConflictCount)
  const notify = useUIStore((s) => s.notify)
  const books = useLibraryStore((s) => s.books)
  const pruneSelection = useUIStore((s) => s.pruneSelection)

  // Selection is pruned to what is actually loaded. Without this, selecting
  // twelve books and then typing a search leaves them selected but invisible,
  // and "Delete 12 books" would delete books the user can no longer see. The
  // cost — narrowing a filter drops the selection — is the intended trade.
  useEffect(() => {
    pruneSelection(books.map((b) => b.id))
  }, [books, pruneSelection])

  useEffect(() => {
    void load()
    void window.Musaeum.metadata
      .getConflictQueue()
      .then((queue) => setConflictCount(queue.length))
      .catch(() => {})

    const unsubs = [
      window.Musaeum.on.libraryChanged(() => void load()),
      window.Musaeum.on.conflictQueueUpdated((count) => setConflictCount(count)),
      window.Musaeum.on.catalogRebuildProgress((p) => setRebuildProgress(p)),
      window.Musaeum.on.bulkHydrateProgress((p) => {
        setBulkHydrate(p.running ? p : null)
        // The status bar counter just disappears when the job ends, which is
        // the least informative moment of a job that may have failed, skipped
        // or been cut short — so the run reports itself once, at the end
        if (!p.running) {
          const summary = describeBulkHydrate(p)
          if (summary) notify(summary)
        }
      }),
      window.Musaeum.on.importProgress((progress) => {
        upsertImportJob(progress)
        if (progress.step === 'done' || progress.step === 'error' || progress.step === 'skipped') {
          // Let finished cards linger briefly, then clear them
          setTimeout(() => removeImportJob(progress.jobId), 5_000)
        }
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [
    load,
    upsertImportJob,
    removeImportJob,
    setRebuildProgress,
    setBulkHydrate,
    setConflictCount,
    notify
  ])
}
