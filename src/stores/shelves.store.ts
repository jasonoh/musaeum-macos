import { create } from 'zustand'
import type { ShelfSummary } from '@shared/shelf.types'
import { reportShelfFailure } from '@/lib/shelf-feedback'

/**
 * The shelves the app knows about: the list the sidebar draws, one book's
 * membership for the places that show it, and a revision that says "what you
 * cached is stale".
 *
 * It holds no opinion about *which* shelf is open. That is the library store's
 * `activeShelfId` (D7) — the scope is a property of the library view, and the
 * reads that apply it are the library store's.
 *
 * Every write lives in main (`services/shelves.ts`) and reports back through
 * `shelves:changed`; this store never updates itself optimistically, so the
 * sidebar cannot show a shelf the share refused to write. `useLibrary` is the
 * one subscriber.
 *
 * A failed *read* is kept quiet here: the list it already has is left alone,
 * and the sentence is main's, said once a session by `reportShelfFailure`.
 */
interface ShelvesState {
  /** Alphabetical, case-insensitive — main's own order. */
  shelves: ShelfSummary[]
  /** Bumped by every `invalidate()`; a consumer re-asks on a change of it. */
  revision: number
  /**
   * `forBook` answers, keyed by book id. **Kept across an `invalidate()`**: the
   * revision is the re-ask trigger, and each answer replaces its own key. See
   * `invalidate` for why emptying this first is the wrong move.
   */
  byBook: Record<string, ShelfSummary[]>

  load(): Promise<void>
  loadForBook(bookId: string): Promise<void>
  /** Main says shelves or membership changed: here, over REST, or by adoption. */
  invalidate(): void
}

export const useShelvesStore = create<ShelvesState>()((set, get) => ({
  shelves: [],
  revision: 0,
  byBook: {},

  async load() {
    try {
      const shelves = await window.Musaeum.shelves.list()
      set({ shelves })
    } catch (err) {
      // Deliberately not `set({ shelves: [] })`: a failed read is not an empty
      // library, and a sidebar that empties itself on a blip teaches the user
      // their shelves are gone. The sentence is main's, and the session says it
      // once — the sidebar's rows here, the phone's toggles and every menu
      // write all end up in the same reporter.
      reportShelfFailure(err)
    }
  },

  async loadForBook(bookId) {
    // The revision is captured *before* the read, not read after it: a
    // `shelves:changed` that lands while this call is in flight has already
    // cleared `byBook` and re-asked, and committing this answer afterwards would
    // put a pre-change membership back under the key and leave it there — the
    // consumer that re-asked has no reason to ask a second time.
    const at = get().revision
    try {
      const shelves = await window.Musaeum.shelves.forBook(bookId)
      set((s) => (s.revision === at ? { byBook: { ...s.byBook, [bookId]: shelves } } : s))
    } catch (err) {
      reportShelfFailure(err)
    }
  },

  invalidate() {
    // The revision *is* the invalidation: every consumer re-asks on it, and each
    // answer replaces its own key. Emptying `byBook` here instead would blank the
    // detail panel's chips and the picker's ticks for the round trip it takes the
    // new answer to land — a flash of "Not on any shelf" on a book that is on
    // three of them, on every shelf change anywhere in the app. Stale for a round
    // trip beats wrong on screen, and the replaced-not-emptied contract is what
    // keeps the cache from outliving the change.
    set((s) => ({ revision: s.revision + 1 }))
  }
}))

/** The shelf with this id, or null — the one lookup the placeholder needs (R3). */
export function shelfById(state: ShelvesState, id: string | null): ShelfSummary | null {
  if (!id) return null
  return state.shelves.find((shelf) => shelf.id === id) ?? null
}
