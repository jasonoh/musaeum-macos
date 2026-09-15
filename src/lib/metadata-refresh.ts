import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { describeHydrate } from '@/lib/metadata-feedback'

/**
 * Re-fetch one book's metadata, with the pending state and the report that the
 * button used to lack.
 *
 * Every entry point goes through here — the detail panel's button today, the
 * context menu too — so the pending spinner, the "already up to date" answer
 * and the failure message cannot differ between two ways of asking the same
 * question.
 *
 * Deliberately not awaited by the buttons themselves: a refresh outlives the
 * panel it was started from, and the thin slice of it that is on screen (the
 * spinner) must be able to disappear without cancelling the work or losing the
 * answer, which arrives as a toast.
 */
export async function refreshBookMetadata(bookId: string): Promise<void> {
  const ui = useUIStore.getState()
  // A second ask while the first is in flight would queue a duplicate fetch at
  // an API that is already rate-limited, and two identical reports afterwards
  if (ui.refreshingBooks[bookId]) return

  const title = useLibraryStore.getState().books.find((b) => b.id === bookId)?.title ?? 'This book'
  ui.setBookRefreshing(bookId, true)

  try {
    const outcome = await window.Musaeum.metadata.rehydrateBook(bookId)
    const { kind, message, detail, actionLabel } = describeHydrate(outcome, title)
    useUIStore.getState().notify({
      kind,
      message,
      detail,
      action: actionLabel
        ? { label: actionLabel, run: () => useUIStore.getState().openModal('conflicts') }
        : undefined
    })
  } catch (err) {
    // The pre-flight failures reject: offline, no metadata engine, nothing
    // hydratable in the book's folder. Each one is a sentence worth reading,
    // so it goes through as the detail rather than being flattened
    useUIStore.getState().notify({
      kind: 'error',
      message: 'Metadata refresh failed',
      detail: `${title} · ${err instanceof Error ? err.message : String(err)}`
    })
  } finally {
    useUIStore.getState().setBookRefreshing(bookId, false)
  }
}
