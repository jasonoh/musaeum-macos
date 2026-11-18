/**
 * Shelves — hand-curated, user-named, non-exclusive lists of books
 * (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`).
 *
 * Two shapes live here. The first half is what crosses the preload bridge (D6):
 * camelCase, computed from the SQLite cache. The second half is the stored file,
 * `{library_root}/shelves.json` (D1): snake_case like `metadata.json`, canonical,
 * and written only by `electron/main/services/shelves.ts`.
 */

/**
 * The kinds this build creates, lists and edits. `queue` is a shelf whose book
 * order is the user's own (`docs/superpowers/specs/2026-11-18-reading-queue-design.md`).
 * Any other kind is preserved, never shown (D1).
 */
export type ShelfKind = 'manual' | 'queue'

/** A shelf as the sidebar and the menus see it. `count` counts only members the library holds (D6). */
export interface ShelfSummary {
  id: string
  name: string
  kind: ShelfKind
  count: number
}

/**
 * One book's place on a shelf — what a remove hands back and an Undo restores,
 * timestamp included (D3). `index` is the member's position at removal and is
 * present only for a queue, where the place is the point.
 */
export interface ShelfMembership {
  bookId: string
  addedAt: string
  index?: number
}

/** Where a book goes in a queue: either end, or beside another member. */
export type ShelfPlacement = { to: 'top' | 'bottom' } | { before: string } | { after: string }

/** What an add did: books newly shelved, and books that were on the shelf already. */
export interface ShelfAddResult {
  added: number
  alreadyOn: number
}

/** Narrows a library read to one shelf (D7). No `shelfId` is the whole library. */
export interface ShelfScope {
  shelfId?: string
}

// --- shelves.json (D1) ---

export interface ShelfBookEntry {
  id: string
  added_at: string
}

export interface ManualShelfEntry {
  id: string
  name: string
  kind: 'manual'
  created_at: string
  updated_at: string
  books: ShelfBookEntry[]
}

/** A shelf whose books are an ordered list: the file's `books` array order is the queue's order. */
export interface QueueShelfEntry {
  id: string
  name: string
  kind: 'queue'
  created_at: string
  updated_at: string
  books: ShelfBookEntry[]
}

/** The kinds this build understands: both carry a named `books` list. */
export type ListShelfEntry = ManualShelfEntry | QueueShelfEntry

/**
 * A shelf of a kind this build does not know — a later build's smart shelf. It
 * is carried through every write exactly as it was read, so an older build's
 * edit cannot destroy it (D1).
 */
export interface ForeignShelfEntry {
  id: string
  kind: string
  [key: string]: unknown
}

export type ShelfEntry = ListShelfEntry | ForeignShelfEntry

export interface ShelvesFile {
  /** The file format's version — independent of the REST `apiVersion`. */
  version: 1
  shelves: ShelfEntry[]
}

export function isManualShelf(entry: ShelfEntry): entry is ManualShelfEntry {
  return entry.kind === 'manual'
}

export function isQueueShelf(entry: ShelfEntry): entry is QueueShelfEntry {
  return entry.kind === 'queue'
}

/** A manual shelf or a queue — every kind this build can read and edit. */
export function isListShelf(entry: ShelfEntry): entry is ListShelfEntry {
  return isManualShelf(entry) || isQueueShelf(entry)
}
