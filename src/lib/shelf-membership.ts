import type { ShelfAddResult, ShelfMembership, ShelfSummary } from '@shared/shelf.types'
import { useUIStore } from '@/stores/ui.store'
import { reportShelfFailure } from '@/lib/shelf-feedback'

/**
 * Putting books on a shelf and taking them off, and the two reports that go with
 * them (D9).
 *
 * One module rather than a call at each surface, because there are five of them
 * — the context menu in both scopes, the selection panel, the picker and the
 * detail panel's chips — and the remove/Undo pair is too easy to get subtly
 * wrong to leave to each.
 *
 * **The timestamps are the point.** `removeBooks` answers with the memberships
 * it removed, `{ bookId, addedAt }` (camelCase on the bridge; `added_at` is the
 * *file's* spelling), and `restoreBooks` puts them back **with those values**,
 * which is what returns a book to its place under *Date Added to Shelf* rather
 * than to the top of it. So they travel untouched: nothing here re-stamps,
 * rebuilds, reorders, filters or renames them — including a membership main will
 * itself skip, because a partial restore is by design and silent, and a second
 * silent filter here would hide a book with nothing on screen saying so.
 *
 * Every function reports its own failure once (through the session reporter) and
 * answers null rather than throwing, so a caller cannot forget — the picker's
 * rows are buttons, and an unhandled rejection behind one is a click that looks
 * like it did nothing.
 */

/** What an add says, or null when it has nothing to report (D9, R9). */
export function describeAdd(shelfName: string, result: ShelfAddResult): string | null {
  if (result.added === 0 && result.alreadyOn === 0) return null
  if (result.added === 0) return `Already on ${shelfName}`
  return result.alreadyOn > 0
    ? `Added ${result.added} to ${shelfName} · ${result.alreadyOn} already there`
    : `Added ${result.added} to ${shelfName}`
}

/** Add books to a shelf, and say what landed. */
export async function addToShelf(
  shelf: ShelfSummary,
  bookIds: string[]
): Promise<ShelfAddResult | null> {
  try {
    const result = await window.Musaeum.shelves.addBooks(shelf.id, bookIds)
    const message = describeAdd(shelf.name, result)
    if (message) useUIStore.getState().notify({ kind: 'success', message })
    return result
  } catch (err) {
    reportShelfFailure(err)
    return null
  }
}

/** The Undo's work: hand main back exactly what main handed over. */
export function undoRemove(shelfId: string, removed: ShelfMembership[]): () => void {
  return () => {
    void window.Musaeum.shelves
      .restoreBooks(shelfId, removed)
      .catch((err) => reportShelfFailure(err))
  }
}

/** Take books off a shelf, report it, and offer the Undo. */
export async function removeFromShelf(
  shelf: ShelfSummary,
  bookIds: string[]
): Promise<ShelfMembership[] | null> {
  try {
    const removed = await window.Musaeum.shelves.removeBooks(shelf.id, bookIds)
    if (removed.length > 0) {
      useUIStore.getState().notify({
        kind: 'success',
        message: `Removed ${removed.length} from ${shelf.name}`,
        action: { label: 'Undo', run: undoRemove(shelf.id, removed) }
      })
    }
    return removed
  } catch (err) {
    reportShelfFailure(err)
    return null
  }
}
