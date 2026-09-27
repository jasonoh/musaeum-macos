/**
 * Shelves — hand-curated, user-named, non-exclusive lists of books
 * (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`).
 *
 * Two shapes live here. The first half is what crosses the preload bridge (D6):
 * camelCase, computed from the SQLite cache. The second half is the stored file,
 * `{library_root}/shelves.json` (D1): snake_case like `metadata.json`, canonical,
 * and written only by `electron/main/services/shelves.ts`.
 */

/** The one kind this build creates, lists and edits. Any other kind is preserved, never shown (D1). */
export type ShelfKind = 'manual'

/** A shelf as the sidebar and the menus see it. `count` counts only members the library holds (D6). */
export interface ShelfSummary {
  id: string
  name: string
  kind: ShelfKind
  count: number
}

/** One book's place on a shelf — what a remove hands back and an Undo restores, timestamp included (D3). */
export interface ShelfMembership {
  bookId: string
  addedAt: string
}

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

export type ShelfEntry = ManualShelfEntry | ForeignShelfEntry

export interface ShelvesFile {
  /** The file format's version — independent of the REST `apiVersion`. */
  version: 1
  shelves: ShelfEntry[]
}

export function isManualShelf(entry: ShelfEntry): entry is ManualShelfEntry {
  return entry.kind === 'manual'
}
