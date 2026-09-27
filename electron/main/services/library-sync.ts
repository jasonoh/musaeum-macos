import type { Book, CatalogSyncOutcome } from '@shared/book.types'
import * as catalog from './catalog'
import * as db from './db'
import { broadcast } from './events'
import * as nas from './nas-manager'
import * as shelves from './shelves'

/**
 * Bridges catalog.json (NAS) and the local SQLite cache. Single-book writes
 * upsert asynchronously off the critical path; launch/connect and the manual
 * refresh/rebuild actions replace the local cache wholesale.
 */

// Roots already applied (or deliberately skipped) this session — reconnects
// must not re-apply and clobber books added since the first sync
const handledRoots = new Set<string>()

// Tracks in-flight fire-and-forget writes so shutdown (and tests) can await
// them — see `flushPendingWrites`.
let pending: Promise<unknown> = Promise.resolve()
function track(p: Promise<unknown>): void {
  // The chain must never reject: it is awaited on the quit path, where a
  // failed catalog write is a tolerable loss (the catalog is derived, and
  // metadata.json already has the truth) but a blocked exit is not. Failures
  // are logged rather than discarded — a silently failing catalog write is
  // exactly the kind of thing that only surfaces as "the other machine never
  // saw my position".
  pending = pending.then(() =>
    p.catch((err) => console.error('[catalog] pending write failed:', err))
  )
}

export function upsertCatalog(books: Book[]): void {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || books.length === 0) return
  track(
    catalog
      .upsertIntoCatalog(root, books, () => db.getBooks())
      .catch((err) => console.error('[catalog] upsert failed:', err))
  )
}

/**
 * Update only `fields` on the catalog's existing entry for each book, rather
 * than replacing the record. For background pushes (reading position) where
 * the rest of this machine's snapshot may be stale — see
 * `catalog.mergeBookFields`.
 */
export function updateCatalogFields(books: Book[], fields: readonly (keyof Book)[]): void {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || books.length === 0) return
  track(
    catalog
      .updateFieldsInCatalog(root, books, fields, () => db.getBooks())
      .catch((err) => console.error('[catalog] field update failed:', err))
  )
}

export function removeBookFromCatalog(bookId: string): void {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline()) return
  track(
    catalog
      .removeFromCatalog(root, bookId, () => db.getBooks())
      .catch((err) => console.error('[catalog] remove failed:', err))
  )
}

/** One batched write from the local cache — call at the end of bulk operations. */
export function writeFullCatalog(root: string | null = nas.getLibraryRoot()): void {
  if (!root) return
  track(
    catalog
      .replaceCatalog(root, db.getBooks())
      .catch((err) => console.error('[catalog] full write failed:', err))
  )
}

/** Hold off the automatic on-connect apply for this root (user chose "Not Now"). */
export function skipRoot(root: string): void {
  handledRoots.add(root)
}

/**
 * Parse `updatedAt` for the reconcile comparison below. Numeric, not
 * lexical: metadata.json is a documented external contract (hand-editable,
 * read by the iOS companion), so a trimmed-milliseconds or explicit-offset
 * timestamp must still compare correctly against Musaeum's own
 * `new Date().toISOString()` writes. A plain string compare gets that
 * backwards — `'…T10:00:00Z' > '…T10:00:00.500Z'` lexically (`'Z'` sorts
 * after `'.'`) even though the millisecond value is later in time. Missing,
 * empty, or unparseable all return `null` so every call site treats "no
 * valid time" as one case rather than risking a `NaN` comparison, which is
 * always `false` and would make an invalid value silently lose in both
 * comparison directions — never a safe default to rely on implicitly.
 */
function parseUpdatedAt(updatedAt: string | undefined): number | null {
  if (!updatedAt) return null
  const parsed = Date.parse(updatedAt)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Reconcile incoming books' reading state against the local cache before a
 * wholesale `db.replaceAllBooks` — call immediately before every one of
 * them. Reading position is written to SQLite on every page turn but reaches
 * the NAS (metadata.json, catalog.json) on a trailing clock: a 30s throttle
 * for the former, session boundaries for the latter, and neither at all
 * while offline (`reading-state.ts` parks the report in memory instead, so
 * quitting offline loses it if nothing here restores it). A wholesale
 * replace with the incoming (stale) catalog view would silently erase the
 * newer local position. Local wins only when it is *strictly* newer, and
 * only when its `updatedAt` actually parses — equal or unparseable-local
 * timestamps keep the incoming record, since adoption is otherwise
 * authoritative. Books whose local state won are pushed back to catalog.json
 * in one batched write so the NAS catches up rather than staying stale.
 *
 * **Both halves of reading state travel together**, because a local win is a
 * win for the record: `read_status` is the other field `reading-state.ts`
 * calls reading state, and a reconcile that carried the newer *position* while
 * taking the catalog's older *status* is how a decision came back undone —
 * measured on the real library, two books un-marked from Reading held Unread
 * in `metadata.json` and Reading in `catalog.json`, and the next launch's
 * adoption put Reading back. A manual change moves the same clock the
 * automatic writers move (`reading-state.noteStatusChange`), so a decision the
 * user made after the catalog's last reading event outranks it.
 *
 * Reads the local cache once — this runs on every connect/refresh over the
 * whole library (~6,900 books), not per book.
 */
function preserveLocalReadingState(incoming: Book[]): Book[] {
  const localById = new Map(db.getBooks().map((b) => [b.id, b]))
  const changed: Book[] = []
  const merged = incoming.map((book) => {
    const local = localById.get(book.id)
    const localState = local?.readingState
    const localTime = parseUpdatedAt(localState?.updatedAt)
    if (localTime === null || !localState) return book
    const incomingTime = parseUpdatedAt(book.readingState?.updatedAt)
    if (incomingTime !== null && incomingTime >= localTime) return book
    const withLocalState: Book = {
      ...book,
      readingState: localState,
      readStatus: local.readStatus
    }
    changed.push(withLocalState)
    return withLocalState
  })
  // Field-merge, not upsert: the rest of each record is the catalog's own
  // (just-read) copy, and the enqueued write re-reads — so replacing the
  // whole entry could undo an edit that landed in between.
  if (changed.length > 0) updateCatalogFields(changed, ['readingState', 'readStatus'])
  return merged
}

/** Adopt the catalog at root as the local cache. Returns the book count. */
export async function applyCatalog(root: string): Promise<number> {
  const cat = await catalog.readCatalog(root)
  if (!cat) throw new Error('No readable catalog.json at the library root')
  adopt(cat.books)
  handledRoots.add(root)
  return cat.books.length
}

/**
 * Land a catalog view as the local cache, and tell the renderer the two things
 * that changed.
 *
 * One function because there are four ways in — the on-connect sync, the manual
 * Reload, the rebuild walk and a direct `applyCatalog` — and the second event is
 * the one that gets forgotten. `replaceAllBooks` prunes the conflicts of any
 * book the incoming catalog no longer has (it runs with the foreign keys off and
 * deletes them in the same transaction), so an adoption can shrink the review
 * queue with nobody resolving anything; the badge in the sidebar is a number the
 * renderer was *told* rather than something it reads (`src/hooks/useLibrary.ts`),
 * so a prune that says nothing leaves it counting a book that is gone. Same
 * symptom as deleting one, through the other door — reported 2026-09-20 for the
 * delete path, and this is its sibling.
 */
function adopt(books: Book[]): void {
  db.replaceAllBooks(preserveLocalReadingState(books))
  broadcast('libraryChanged')
  broadcast('conflictQueueUpdated', db.getUnresolvedConflictCount())
}

/**
 * Once per session per root, when the library connects: adopt the catalog if
 * one exists; otherwise bootstrap it from a non-empty local cache (first
 * launch of a pre-catalog library).
 */
export async function syncOnConnect(): Promise<void> {
  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || handledRoots.has(root)) return
  handledRoots.add(root)
  try {
    const result = await catalog.readCatalogDetailed(root)
    if (result.state === 'ok') {
      adopt(result.file.books)
    } else if (result.state === 'missing' && db.getBooks().length > 0) {
      // Pre-catalog library on this machine: bootstrap the catalog from cache
      await catalog.replaceCatalog(root, db.getBooks())
    } else if (result.state === 'invalid') {
      // Never bootstrap over a catalog that exists but can't be read — this
      // machine's cache may be stale; recovery is the manual rebuild action
      console.error(
        '[catalog] catalog.json exists but is unreadable — skipping sync; use Rebuild Catalog'
      )
    }
  } catch (err) {
    // Transient read failure: log and delete from handledRoots so a later
    // reconnect retries the sync instead of being permanently skipped
    console.error('[catalog] on-connect sync failed:', err)
    handledRoots.delete(root)
  }
  // Shelves are their own canonical file (bookshelves D1, D4), adopted after the
  // book swap so a member whose book just arrived is counted. Outside the
  // catalog's try: a missing or unreadable catalog says nothing about
  // shelves.json, and `adopt` never rejects.
  await shelves.adopt(root)
}

/**
 * Manual refresh: re-read the catalog; walk-and-rebuild when it is missing.
 *
 * The two outcomes are the same shape because this *becomes* the rebuild when
 * the catalog can't be read — which is what the Settings copy has to disclose,
 * since the only difference a user sees otherwise is a job that ought to take a
 * second taking minutes.
 */
export async function refreshLibrary(): Promise<CatalogSyncOutcome> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const result = await catalog.readCatalogDetailed(root)
  let outcome: CatalogSyncOutcome
  if (result.state !== 'ok') {
    outcome = await rebuildCatalog()
  } else {
    adopt(result.file.books)
    handledRoots.add(root)
    outcome = { books: result.file.books.length, cancelled: false }
  }
  // Reload re-reads shelves.json too (bookshelves D4) — here, after the swap,
  // and not in `rebuildCatalog`, which the spec keeps away from shelves. A
  // cancelled walk changed no books, so the shelves have nothing to catch up on.
  if (!outcome.cancelled) await shelves.adopt(root)
  return outcome
}

// Read by the walk's per-folder predicate, set by `cancelRefresh`.
//
// No "is anything running?" guard: `rebuildCatalog` resets this before every
// walk, so a cancel that arrives while nothing is running — or while a plain
// refresh (a catalog read with nothing to stop) is — is wiped by the next run
// rather than aborting it. That reset is the mechanism, and it is pinned by
// `stops the walk on cancel and writes nothing`'s sibling in
// `library-sync.test.ts`. A `rebuilding` flag was tried here first and removed:
// it claimed to protect that case and the mutation campaign showed it could be
// deleted without any test noticing.
let rebuildCancelled = false

/** Stop a running rebuild. A no-op when nothing is running. */
export function cancelRefresh(): void {
  rebuildCancelled = true
}

/** Recovery: walk books/<uuid>/metadata.json, rewrite the catalog, reload the cache. */
export async function rebuildCatalog(): Promise<CatalogSyncOutcome> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  rebuildCancelled = false
  const walked = await catalog.rebuildFromBookDirs(
    root,
    (p) => broadcast('catalogRebuildProgress', p),
    () => rebuildCancelled
  )
  // `walked` is [] both when the user stopped the walk and when the library has
  // no books — the flag is the only thing that tells them apart, and the walk
  // wrote nothing in the cancelled case (catalog.ts)
  if (rebuildCancelled) return { books: 0, cancelled: true }
  adopt(walked)
  handledRoots.add(root)
  // Bare `false`: the early return above holds whenever the flag is set, so
  // reading it here would be the same value by a longer route
  return { books: walked.length, cancelled: false }
}

/**
 * Await every catalog write dispatched so far. The upsert helpers above are
 * deliberately fire-and-forget — they sit on the critical path of an import
 * or a page turn — but quit has to wait for them or `teardown` closes the
 * database and exits with catalog.json's read-modify-write still in flight,
 * leaving the derived cache one session behind on every machine. Never
 * rejects (see `track`); callers bound it with their own timeout rather than
 * this module arming a second one.
 */
export function flushPendingWrites(): Promise<void> {
  return pending.then(() => undefined)
}

/** Test-only helpers. */
export function resetForTests(): void {
  handledRoots.clear()
}
/** Alias of `flushPendingWrites`, kept for the tests that predate it. */
export function flushForTests(): Promise<unknown> {
  return flushPendingWrites()
}
