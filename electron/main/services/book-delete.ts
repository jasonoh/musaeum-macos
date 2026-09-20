import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { BulkDeleteResult } from '@shared/api.types'
import type { BookFormat } from '@shared/book.types'
import { computeFileSizeBytes } from './book-files'
import * as db from './db'
import { broadcast } from './events'
import { writeMetadataJson } from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

/**
 * A folder that will not go away is logged, never fatal: by the time this runs
 * the book is already out of the library, and a delete must not report a
 * failure it did not have.
 */
async function removeFolder(dir: string, id: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (err) {
    console.error(`[delete] could not remove ${dir} for ${id}:`, err)
  }
}

/** Remove a book, its NAS folder, its cache row, and its catalog entry. */
export async function deleteBook(id: string): Promise<void> {
  nas.assertOnline()
  const book = db.getBook(id)
  // The row goes before the files. With the folder first, anything that made
  // the row delete fail (a `device_history` FK on a book that had been sent —
  // migration 005 — or any other SQLite error) left the library showing a book
  // whose files were already gone: unopenable, and undeletable for the same
  // reason. The reverse costs a stray folder on the share, which is visible in
  // Finder and recoverable; an entry pointing at nothing is neither.
  db.deleteBook(id)
  if (book?.nasPath) {
    await removeFolder(join(nas.getLibraryRoot()!, book.nasPath), id)
  }
  librarySync.removeBookFromCatalog(id)
  broadcast('libraryChanged')
}

/**
 * Delete individual format files from a book. Selecting every format the book
 * has is equivalent to deleting the book — a book with no files left is not a
 * library entry worth keeping — so that path falls through to `deleteBook` and
 * reports `bookDeleted: true` so the UI can drop its selection.
 */
export async function deleteFormats(
  id: string,
  formats: BookFormat[]
): Promise<{ bookDeleted: boolean }> {
  nas.assertOnline()
  const book = db.getBook(id)
  if (!book) throw new Error('Book not found')

  const requested = book.formats.filter((f) => formats.includes(f))
  if (!requested.length) throw new Error('No matching formats to delete')

  const remaining = book.formats.filter((f) => !requested.includes(f))
  if (!remaining.length) {
    await deleteBook(id)
    return { bookDeleted: true }
  }

  if (book.nasPath) {
    const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
    // Match by extension rather than by canonical name: a book imported before
    // a title edit still carries its original file name on disk.
    const exts = new Set(requested.map((f) => `.${f}`))
    for (const entry of await fs.readdir(bookDir)) {
      if (exts.has(extname(entry).toLowerCase())) {
        await fs.rm(join(bookDir, entry), { force: true })
      }
    }
    // Recompute rather than subtract: file_size_bytes is set at import and
    // never revisited otherwise, so trusting the stored value here would just
    // carry forward whatever drift already existed. Non-fatal — a readdir/stat
    // failure on a flaky share keeps the previous value rather than failing the
    // delete.
    const fileSizeBytes = (await computeFileSizeBytes(bookDir)) ?? book.fileSizeBytes
    db.updateBook(id, { formats: remaining, fileSizeBytes })
    const updated = db.getBook(id)!
    await writeMetadataJson(bookDir, updated)
    librarySync.upsertCatalog([updated])
  } else {
    db.updateBook(id, { formats: remaining })
  }

  broadcast('libraryChanged')
  return { bookDeleted: false }
}

/**
 * Delete many books in one pass.
 *
 * Not a loop over `deleteBook`: that function removes each book from the
 * catalog individually, and every one of those enqueues a **whole-file**
 * rewrite of catalog.json over SMB, plus a `libraryChanged` broadcast that
 * reloads the entire library in the renderer. For a dozen books that is a
 * dozen ~10MB writes and a dozen reloads. This does the per-book work with no
 * catalog contact at all and finishes with one batched write.
 *
 * One book's failure never aborts the rest — the books are independent
 * folders on a share that may be flaky, and eleven successful deletions plus
 * an honest report beats a half-finished batch.
 */
export async function deleteBooks(ids: string[]): Promise<BulkDeleteResult> {
  nas.assertOnline()
  const root = nas.getLibraryRoot()!
  const failed: BulkDeleteResult['failed'] = []
  let deleted = 0

  for (const id of ids) {
    const book = db.getBook(id)
    if (!book) {
      failed.push({ id, title: id, error: 'Book not found' })
      continue
    }
    try {
      // Same order as the single-book path, and for the same reason
      db.deleteBook(id)
      if (book.nasPath) {
        await removeFolder(join(root, book.nasPath), id)
      }
      deleted++
    } catch (err) {
      failed.push({
        id,
        title: book.title,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  if (deleted > 0) {
    librarySync.writeFullCatalog()
    broadcast('libraryChanged')
  }
  return { deleted, failed }
}
