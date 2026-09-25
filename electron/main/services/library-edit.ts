import { join } from 'path'
import type { Book } from '@shared/book.types'
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
  // A read-status change is a decision about reading state, so it moves that
  // state's clock — before the `getBook` below, so the metadata.json written
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
