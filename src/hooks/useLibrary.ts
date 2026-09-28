import { useEffect } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { useUIStore } from '@/stores/ui.store'
import { describeBulkHydrate } from '@/lib/metadata-feedback'

/** Wire the library store to main-process events. Mount once at app root. */
export function useLibrary(): void {
  const load = useLibraryStore((s) => s.load)
  const upsertImportJob = useLibraryStore((s) => s.upsertImportJob)
  const removeImportJob = useLibraryStore((s) => s.removeImportJob)
  const setCatalogRebuildProgress = useLibraryStore((s) => s.setCatalogRebuildProgress)
  const setBulkHydrate = useLibraryStore((s) => s.setBulkHydrate)
  const reconcileScope = useLibraryStore((s) => s.reconcileScope)
  const loadShelves = useShelvesStore((s) => s.load)
  const invalidateShelves = useShelvesStore((s) => s.invalidate)
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
    // The sidebar draws this list, so it is read once here rather than from
    // `ShelfList`: a component that fetched it would be a second path into the
    // same store, and the first paint would be empty until it ran
    void loadShelves()
    void window.Musaeum.metadata
      .getConflictQueue()
      .then((queue) => setConflictCount(queue.length))
      .catch(() => {})

    const unsubs = [
      window.Musaeum.on.libraryChanged(() => void load()),
      window.Musaeum.on.conflictQueueUpdated((count) => setConflictCount(count)),
      window.Musaeum.on.catalogRebuildProgress((p) => setCatalogRebuildProgress(p)),
      /**
       * One shelf signal, one path (D9, slice 1's second handoff note). The list
       * is re-read because the sidebar draws it; every cached per-book answer is
       * dropped because membership just moved; the open shelf's own rows are
       * re-read — nothing outside a shelf changes, and `libraryChanged` (which
       * re-reads unconditionally) is not this event; and a scope whose shelf has
       * gone clears itself, which is the one thing standing between a delete on
       * another Mac and a view that answers nothing and refuses every write.
       *
       * The reconcile waits for the read rather than running beside it: the list
       * in the store at this moment is the one from the *previous* change, and
       * reconciling against it would clear a scope whose shelf was created a
       * moment ago.
       */
      window.Musaeum.shelves.onChanged(() => {
        invalidateShelves()
        void loadShelves().then(() => {
          reconcileScope(useShelvesStore.getState().shelves.map((s) => s.id))
          if (useLibraryStore.getState().activeShelfId) void load()
        })
      }),
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
    loadShelves,
    invalidateShelves,
    reconcileScope,
    upsertImportJob,
    removeImportJob,
    setCatalogRebuildProgress,
    setBulkHydrate,
    setConflictCount,
    notify
  ])
}
