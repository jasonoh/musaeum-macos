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
  /** `forBook` answers, keyed by book id. Emptied by every `invalidate()`. */
  byBook: Record<string, ShelfSummary[]>

  load(): Promise<void>
  loadForBook(bookId: string): Promise<void>
  /** Main says shelves or membership changed: here, over REST, or by adoption. */
  invalidate(): void
}

export const useShelvesStore = create<ShelvesState>()((set) => ({
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
    try {
      const shelves = await window.Musaeum.shelves.forBook(bookId)
      set((s) => ({ byBook: { ...s.byBook, [bookId]: shelves } }))
    } catch (err) {
      reportShelfFailure(err)
    }
  },

  invalidate() {
    set((s) => ({ revision: s.revision + 1, byBook: {} }))
  }
}))

/** The shelf with this id, or null — the one lookup the placeholder needs (R3). */
export function shelfById(state: ShelvesState, id: string | null): ShelfSummary | null {
  if (!id) return null
  return state.shelves.find((shelf) => shelf.id === id) ?? null
}
