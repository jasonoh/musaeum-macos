import { useEffect } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'

/** Wire the library store to main-process events. Mount once at app root. */
export function useLibrary(): void {
  const load = useLibraryStore((s) => s.load)
  const upsertImportJob = useLibraryStore((s) => s.upsertImportJob)
  const removeImportJob = useLibraryStore((s) => s.removeImportJob)
  const setRebuildProgress = useLibraryStore((s) => s.setRebuildProgress)
  const setConflictCount = useUIStore((s) => s.setConflictCount)

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
      window.Musaeum.on.importProgress((progress) => {
        upsertImportJob(progress)
        if (progress.step === 'done' || progress.step === 'error' || progress.step === 'skipped') {
          // Let finished cards linger briefly, then clear them
          setTimeout(() => removeImportJob(progress.jobId), 5_000)
        }
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [load, upsertImportJob, removeImportJob, setRebuildProgress, setConflictCount])
}
