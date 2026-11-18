import type {
  ShelfAddResult,
  ShelfMembership,
  ShelfPlacement,
  ShelfSummary
} from '@shared/shelf.types'
import { useUIStore } from '@/stores/ui.store'
import { useLibraryStore } from '@/stores/library.store'
import { reportShelfFailure } from '@/lib/shelf-feedback'
import { applyPlacement } from '@/lib/queue-order'

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
 * **Moves live here too** (a queue's reorder: `sendMove`, `moveToEdge`, `reorderInQueue`). A move has
 * no Undo, so there is nothing to hand back; the placement goes to main exactly as
 * built — main refuses any extra key, even an undefined one.
 *
 * Every function reports its own failure once (through the session reporter) and
 * answers null (the add and remove helpers) or false (the move helpers) rather than
 * throwing, so a caller cannot forget — the picker's
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

/**
 * One `shelves.move`, reported once on refusal. True when main took it, false when
 * it refused (the sentence has already been said); never throws. The placement is
 * passed through untouched.
 */
export async function sendMove(
  shelfId: string,
  bookIds: readonly string[],
  placement: ShelfPlacement
): Promise<boolean> {
  try {
    await window.Musaeum.shelves.move(shelfId, [...bookIds], placement)
    return true
  } catch (err) {
    reportShelfFailure(err)
    return false
  }
}

/** Move the books to the top or bottom of a queue. */
export function moveToEdge(
  shelfId: string,
  bookIds: readonly string[],
  edge: 'top' | 'bottom'
): Promise<boolean> {
  return sendMove(shelfId, bookIds, { to: edge })
}

/**
 * Reorder the open queue by a drag: show the result at once, ask main, and take it
 * back if main refuses. Resolves true when main took the move; false when the drop
 * changes nothing or the shelf is not the open one (no IPC call either way), or
 * when main refused (reported once, and the rows go back).
 *
 * The view holds the pending order until the authoritative read lands:
 * `setBookOrder` and `settleReorder` each bump `reorderGen`, which makes any
 * `load()` that was already in flight discard its answer instead of snapping the
 * rows back. The closing `load()` is awaited whatever the outcome, which is also
 * what resets a `loading` flag a discarded read left set.
 */
export async function reorderInQueue(
  shelfId: string,
  moved: readonly string[],
  placement: ShelfPlacement
): Promise<boolean> {
  const library = useLibraryStore.getState()
  if (library.activeShelfId !== shelfId) return false
  const previous = library.books.map((b) => b.id)
  const next = applyPlacement(previous, moved, placement)
  if (next.length === previous.length && next.every((id, i) => id === previous[i])) return false

  library.setBookOrder(next)
  let ok: boolean
  try {
    ok = await sendMove(shelfId, moved, placement)
    // Only while the queue it was for is still the open one: the reader can open
    // another shelf while the move is in flight, and putting this queue's order
    // onto that shelf's rows would paint one shelf's books in another's order
    // until the closing read lands
    if (!ok && useLibraryStore.getState().activeShelfId === shelfId) {
      useLibraryStore.getState().setBookOrder(previous)
    }
  } finally {
    useLibraryStore.getState().settleReorder()
    await useLibraryStore.getState().load()
  }
  return ok
}
