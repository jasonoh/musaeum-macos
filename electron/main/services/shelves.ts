import { randomUUID } from 'crypto'
import type {
  ManualShelfEntry,
  ShelfAddResult,
  ShelfMembership,
  ShelfSummary,
  ShelvesFile
} from '@shared/shelf.types'
import { isManualShelf } from '@shared/shelf.types'
import * as db from './db'
import { broadcast } from './events'
import * as nas from './nas-manager'
import { emptyShelvesFile, readShelvesFile, writeShelvesFile } from './shelves-file'

/**
 * Every shelf write goes through here (`docs/superpowers/specs/2026-09-27-bookshelves-design.md`,
 * D3), and each one runs the same seven steps: assert the library is writable;
 * enter the one queue; **re-read** `shelves.json`; apply the change to what was
 * read; write it atomically; replace the SQLite cache from what was written;
 * broadcast `shelvesChanged`.
 *
 * - **File first, cache second.** A failed share write leaves the cache as it
 *   was, so the UI never shows a membership the file does not hold. A crash
 *   between the two is repaired by the next adoption, because the file is
 *   canonical.
 * - **Re-read every time.** Another Mac may have written since this one last
 *   looked; the change applies to the file as it is now, which is also why no
 *   tombstones are needed (D1).
 * - **One write per operation**, whatever the number of books — and none for an
 *   operation that changes nothing.
 * - **A file that exists but cannot be read is never overwritten.** Every
 *   mutation refuses with `SHELVES_UNREADABLE` until someone repairs it.
 */

export const SHELF_NAME_MAX = 80
export const SHELVES_UNREADABLE =
  'shelves.json could not be read — shelf changes are paused so nothing is lost'
export const SHELF_GONE = 'That shelf no longer exists'

/** A mutation that found its shelf absent from the re-read file — deleted on another Mac. */
class ShelfGoneError extends Error {
  constructor() {
    super(SHELF_GONE)
  }
}

/**
 * Whether a mutation refused because its shelf was gone from the re-read file
 * (`SHELF_GONE`) — the REST surface's 404 (bookshelves D10, S3). A predicate
 * rather than the exported class: the class stays private and the wire's mapping
 * stays one call.
 */
export function isShelfGone(err: unknown): boolean {
  return err instanceof ShelfGoneError
}

/** What applying a change to the file produced: its answer, and whether there is anything to write. */
interface Applied<T> {
  result: T
  changed: boolean
}

// One queue per process — two writes interleaving their read-modify-write would
// lose one of them. Same shape as catalog.ts's.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

async function mutate<T>(apply: (file: ShelvesFile, now: string) => Applied<T>): Promise<T> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  return enqueue(async () => {
    const read = await readShelvesFile(root)
    if (read.state === 'invalid') throw new Error(SHELVES_UNREADABLE)
    const file = read.state === 'ok' ? read.file : emptyShelvesFile()
    let applied: Applied<T>
    try {
      applied = apply(file, new Date().toISOString())
    } catch (err) {
      if (err instanceof ShelfGoneError) {
        // The file just read is canonical and no longer holds the shelf, but the
        // cache still does: replace it, or the sidebar keeps offering a shelf
        // that every action refuses. Every `apply` looks its shelf up before it
        // changes anything, so `file` is still exactly what was read.
        db.replaceAllShelves(file)
        broadcast('shelvesChanged')
      }
      throw err
    }
    if (!applied.changed) return applied.result
    await writeShelvesFile(root, file)
    db.replaceAllShelves(file)
    broadcast('shelvesChanged')
    return applied.result
  })
}

function findShelf(file: ShelvesFile, id: string): ManualShelfEntry {
  const shelf = file.shelves.find((s): s is ManualShelfEntry => isManualShelf(s) && s.id === id)
  if (!shelf) throw new ShelfGoneError()
  return shelf
}

/** Trimmed, non-empty, at most 80 characters (counted as characters, not UTF-16 units). */
function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('A shelf needs a name.')
  if ([...name].length > SHELF_NAME_MAX) {
    throw new Error(`A shelf name can be at most ${SHELF_NAME_MAX} characters.`)
  }
  return name
}

// `toLowerCase()`, not `toLocaleLowerCase()`: name uniqueness is a rule about
// a file several Macs share, and locale-dependent folding (Turkish I) could
// make two Macs disagree about whether two names clash.
const foldName = (name: string): string => name.normalize('NFC').toLowerCase()

/**
 * Unique case-insensitively among manual shelves, checked against the re-read
 * file. A clash is refused, never auto-suffixed (D3). `selfId` lets a shelf be
 * renamed to its own name in another case.
 */
function assertNameFree(file: ShelvesFile, name: string, selfId: string | null): void {
  const key = foldName(name)
  const clash = file.shelves.find(
    (s): s is ManualShelfEntry => isManualShelf(s) && s.id !== selfId && foldName(s.name) === key
  )
  if (clash) throw new Error(`There is already a shelf named “${clash.name}”.`)
}

/**
 * Put books on a shelf. An existing member keeps its `added_at` (idempotent);
 * an id the library does not hold is skipped and counted nowhere (D3).
 */
function addMembers(shelf: ManualShelfEntry, bookIds: unknown, now: string): ShelfAddResult {
  const on = new Set(shelf.books.map((m) => m.id))
  let added = 0
  let alreadyOn = 0
  for (const id of new Set(Array.isArray(bookIds) ? bookIds : [])) {
    if (typeof id !== 'string') continue
    if (on.has(id)) {
      alreadyOn++
      continue
    }
    if (!db.bookExists(id)) continue
    shelf.books.push({ id, added_at: now })
    on.add(id)
    added++
  }
  return { added, alreadyOn }
}

function isMembership(value: unknown): value is ShelfMembership {
  if (typeof value !== 'object' || value === null) return false
  const { bookId, addedAt } = value as { bookId?: unknown; addedAt?: unknown }
  return (
    typeof bookId === 'string' && bookId !== '' && typeof addedAt === 'string' && addedAt !== ''
  )
}

// --- Reads: from the cache, never the share ---

export function list(): ShelfSummary[] {
  return db.listShelves()
}

export function forBook(bookId: string): ShelfSummary[] {
  return db.shelvesForBook(bookId)
}

// --- Mutations ---

export async function create(name: string, bookIds: string[] = []): Promise<ShelfSummary> {
  const clean = cleanName(name)
  return mutate((file, now) => {
    assertNameFree(file, clean, null)
    const shelf: ManualShelfEntry = {
      id: randomUUID(),
      name: clean,
      kind: 'manual',
      created_at: now,
      updated_at: now,
      books: []
    }
    addMembers(shelf, bookIds, now)
    file.shelves.push(shelf)
    // Answered from what was written, not read back from the cache afterwards —
    // by then the queue may have run another change
    return {
      result: { id: shelf.id, name: shelf.name, kind: 'manual', count: shelf.books.length },
      changed: true
    }
  })
}

export async function addBooks(id: string, bookIds: string[]): Promise<ShelfAddResult> {
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    const result = addMembers(shelf, bookIds, now)
    if (result.added > 0) shelf.updated_at = now
    return { result, changed: result.added > 0 }
  })
}

/** Take books off a shelf. Returns what was removed, timestamps included, for an Undo. */
export async function removeBooks(id: string, bookIds: string[]): Promise<ShelfMembership[]> {
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    const drop = new Set(Array.isArray(bookIds) ? bookIds : [])
    const removed: ShelfMembership[] = []
    shelf.books = shelf.books.filter((m) => {
      if (!drop.has(m.id)) return true
      removed.push({ bookId: m.id, addedAt: m.added_at })
      return false
    })
    if (removed.length > 0) shelf.updated_at = now
    return { result: removed, changed: removed.length > 0 }
  })
}

/**
 * Undo a remove: put the memberships back **with their original `added_at`**,
 * so a book returns to its place under *Date Added to Shelf* (D3). A book
 * already back on the shelf keeps the membership it has; one the library no
 * longer holds is skipped, as an add would skip it.
 */
export async function restoreBooks(id: string, memberships: ShelfMembership[]): Promise<void> {
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    const on = new Set(shelf.books.map((m) => m.id))
    let restored = 0
    for (const m of Array.isArray(memberships) ? memberships : []) {
      if (!isMembership(m) || on.has(m.bookId) || !db.bookExists(m.bookId)) continue
      shelf.books.push({ id: m.bookId, added_at: m.addedAt })
      on.add(m.bookId)
      restored++
    }
    if (restored > 0) shelf.updated_at = now
    return { result: undefined, changed: restored > 0 }
  })
}

export async function rename(id: string, name: string): Promise<void> {
  const clean = cleanName(name)
  return mutate((file, now) => {
    const shelf = findShelf(file, id)
    assertNameFree(file, clean, id)
    if (shelf.name === clean) return { result: undefined, changed: false }
    shelf.name = clean
    shelf.updated_at = now
    return { result: undefined, changed: true }
  })
}

/** Remove a shelf. Its books stay in the library — a shelf is a list, not a container. */
export async function deleteShelf(id: string): Promise<void> {
  return mutate((file) => {
    findShelf(file, id)
    file.shelves = file.shelves.filter((s) => !(isManualShelf(s) && s.id === id))
    return { result: undefined, changed: true }
  })
}

/**
 * Take deleted books off every shelf — **one** write for the whole batch, never
 * one per book (D5). No write at all when no shelf holds any of them, so a
 * library that has never used shelves never gets a `shelves.json` from a
 * delete. May reject; `book-delete.ts` logs and swallows that, because the book
 * is already gone (invariant 12).
 */
export async function pruneBooks(bookIds: string[]): Promise<void> {
  if (bookIds.length === 0) return
  return mutate((file, now) => {
    const gone = new Set(bookIds)
    let changed = false
    for (const shelf of file.shelves) {
      if (!isManualShelf(shelf)) continue
      const kept = shelf.books.filter((m) => !gone.has(m.id))
      if (kept.length === shelf.books.length) continue
      shelf.books = kept
      shelf.updated_at = now
      changed = true
    }
    return { result: undefined, changed }
  })
}

// Adoption logs an unreadable file once a session, not on every connect and Reload
let reportedUnreadable = false

/** Test-only: undo `reportedUnreadable`'s carry-over between tests in one file. */
export function resetAdoptionLogForTests(): void {
  reportedUnreadable = false
}

/**
 * Land `shelves.json` in the cache — on connect and on Reload, after the book
 * swap (D4). Through the same queue as the writes: an adoption that read the
 * file just before a write landed must not replace the cache after it and undo
 * it.
 *
 * - A missing file is a library with no shelves, and **empties** the cache — a
 *   root switched to another library must not keep showing the last one's.
 * - An unreadable file leaves the cache as it was: browsing continues from the
 *   last good view, and the writes refuse until it is repaired.
 * - Never rejects: a shelf problem must not fail a catalog sync.
 */
export function adopt(root: string): Promise<void> {
  return enqueue(async () => {
    try {
      const read = await readShelvesFile(root)
      if (read.state === 'invalid') {
        if (!reportedUnreadable) {
          console.error(`[shelves] ${SHELVES_UNREADABLE}; keeping the last adopted shelves`)
          reportedUnreadable = true
        }
        return
      }
      db.replaceAllShelves(read.state === 'ok' ? read.file : emptyShelvesFile())
      reportedUnreadable = false // a repaired (or never-broken) file is news again if it breaks later
      broadcast('shelvesChanged')
    } catch (err) {
      console.error(
        '[shelves] could not read shelves.json — keeping the last adopted shelves:',
        err
      )
    }
  })
}
