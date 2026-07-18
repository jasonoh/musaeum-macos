import type { Book } from '@shared/book.types'
import * as catalog from './catalog'
import * as db from './db'
import { broadcast } from './events'
import * as nas from './nas-manager'

/**
 * Bridges catalog.json (NAS) and the local SQLite cache. Single-book writes
 * upsert asynchronously off the critical path; launch/connect and the manual
 * refresh/rebuild actions replace the local cache wholesale.
 */

// Roots already applied (or deliberately skipped) this session — reconnects
// must not re-apply and clobber books added since the first sync
const handledRoots = new Set<string>()

// Tracks in-flight fire-and-forget writes so tests (and shutdown) can await them
let pending: Promise<unknown> = Promise.resolve()
function track(p: Promise<unknown>): void {
  pending = pending.then(() => p.catch(() => undefined))
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

/** Adopt the catalog at root as the local cache. Returns the book count. */
export async function applyCatalog(root: string): Promise<number> {
  const cat = await catalog.readCatalog(root)
  if (!cat) throw new Error('No readable catalog.json at the library root')
  db.replaceAllBooks(cat.books)
  handledRoots.add(root)
  broadcast('libraryChanged')
  return cat.books.length
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
      db.replaceAllBooks(result.file.books)
      broadcast('libraryChanged')
    } else if (result.state === 'missing' && db.getBooks().length > 0) {
      // Pre-catalog library on this machine: bootstrap the catalog from cache
      await catalog.replaceCatalog(root, db.getBooks())
    } else if (result.state === 'invalid') {
      // Never bootstrap over a catalog that exists but can't be read — this
      // machine's cache may be stale; recovery is the manual rebuild action
      console.error('[catalog] catalog.json exists but is unreadable — skipping sync; use Rebuild Catalog')
    }
  } catch (err) {
    // Transient read failure: log and delete from handledRoots so a later
    // reconnect retries the sync instead of being permanently skipped
    console.error('[catalog] on-connect sync failed:', err)
    handledRoots.delete(root)
  }
}

/** Manual refresh: re-read the catalog; walk-and-rebuild when it is missing. */
export async function refreshLibrary(): Promise<{ books: number }> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const result = await catalog.readCatalogDetailed(root)
  if (result.state !== 'ok') return rebuildCatalog()
  db.replaceAllBooks(result.file.books)
  handledRoots.add(root)
  broadcast('libraryChanged')
  return { books: result.file.books.length }
}

/** Recovery: walk books/<uuid>/metadata.json, rewrite the catalog, reload the cache. */
export async function rebuildCatalog(): Promise<{ books: number }> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const books = await catalog.rebuildFromBookDirs(root, (p) =>
    broadcast('catalogRebuildProgress', p)
  )
  db.replaceAllBooks(books)
  handledRoots.add(root)
  broadcast('libraryChanged')
  return { books: books.length }
}

/** Test-only helpers. */
export function resetForTests(): void {
  handledRoots.clear()
}
export function flushForTests(): Promise<unknown> {
  return pending
}
