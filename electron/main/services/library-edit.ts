import { join } from 'path'
import type { Book } from '@shared/book.types'
import type { HydratedField } from '@shared/metadata.types'
import * as bookFiles from './book-files'
import * as db from './db'
import { broadcast } from './events'
import * as fieldOverrides from './field-overrides'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as readingState from './reading-state'

/**
 * A metadata-editor save — `library:updateBook`'s body, moved out of the IPC
 * layer so the handler stays a thin wrapper (`CLAUDE.md` #8). One of the three
 * paths on which a settled title renames its files (`CLAUDE.md` #6; see
 * `docs/invariants/files-and-deletion.md`); the order below is load-bearing.
 */
export async function updateBook(id: string, updates: Partial<Book>): Promise<void> {
  nas.assertOnline()
  // The row before the write: what a patch *changed* is the difference from
  // it, and the marking therefore has to run after the write, with this
  // captured first (design D5)
  const before = db.getBook(id)
  db.updateBook(id, updates)
  // A read-status change is a decision about the status, so it moves the
  // status clock — before the `getBook` below, so the metadata.json written
  // after it carries the same clock. Without it the decision is one adoption
  // cannot order, and the next launch's catalog wins (`CLAUDE.md` #5).
  readingState.noteStatusChange(id, updates, before)
  // Every field this patch actually changed is now the user's decision, and a
  // fetch must not move it. A patch that only restates the row locks nothing.
  fieldOverrides.markFromPatch(id, updates, before)
  // Persist to the NAS metadata.json when reachable; cache-only edits would
  // otherwise drift from the canonical file
  const book = db.getBook(id)
  if (book?.nasPath && nas.isOnline()) {
    const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
    await importer.writeMetadataJson(bookDir, book)
    librarySync.upsertCatalog([book])
    // After the canonical record, never before it: the files are named from
    // the title but nothing reads those names, so a failure here must not
    // cost the user an edit that has already been saved
    await bookFiles.renameToTitle(bookDir, book.title)
  }
  broadcast('libraryChanged')
}

/**
 * Release a held field: the value stays, a fetch may propose it again. A
 * release is a change to the book's record, so it is written where an edit is —
 * to `metadata.json` and the catalog — and, like an edit, it needs the library
 * online: an offline release would be re-imposed by the next adoption, which
 * would read the other machine's still-held claim as newer news. Releasing a
 * field that is not held is a no-op beyond the online check.
 */
export async function releaseFieldOverride(
  id: string,
  field: HydratedField
): Promise<HydratedField[]> {
  nas.assertOnline()
  // Nothing held, nothing to hand back: no record write, no catalog upsert, no
  // broadcast — a release that changed nothing must not move the record's clock
  const held = fieldOverrides.list(id)
  if (!held.includes(field)) return held
  const remaining = fieldOverrides.release(id, field)
  const book = db.getBook(id)
  if (book?.nasPath) {
    await importer.writeMetadataJson(join(nas.getLibraryRoot()!, book.nasPath), book)
    librarySync.upsertCatalog([book])
  }
  broadcast('libraryChanged')
  return remaining
}
