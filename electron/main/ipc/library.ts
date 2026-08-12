import { join } from 'path'
import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  DuplicateDecision
} from '@shared/book.types'
import * as bookDelete from '../services/book-delete'
import * as bookFiles from '../services/book-files'
import * as db from '../services/db'
import { broadcast } from '../services/events'
import * as importer from '../services/importer'
import * as librarySync from '../services/library-sync'
import * as nas from '../services/nas-manager'
import { handle } from './handle'

export function registerLibraryHandlers(): void {
  handle('library:getBooks', (filters?: BookFilters) => db.getBooks(filters))

  handle('library:getBook', (id: string) => {
    const book = db.getBook(id)
    if (!book) throw new Error('Book not found')
    return book
  })

  handle('library:searchBooks', (query: string, sort?: BookSort) => db.searchBooks(query, sort))

  handle('library:getFacets', () => db.getFacets())

  handle('library:refreshLibrary', () => librarySync.refreshLibrary())
  handle('library:rebuildCatalog', () => librarySync.rebuildCatalog())

  handle('library:updateBook', async (id: string, updates: Partial<Book>) => {
    nas.assertOnline()
    db.updateBook(id, updates)
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
  })

  handle('library:deleteBook', (id: string) => bookDelete.deleteBook(id))

  handle('library:deleteFormats', (id: string, formats: BookFormat[]) =>
    bookDelete.deleteFormats(id, formats)
  )

  // Import lives in the library domain
  handle('import:addFiles', (filePaths: string[]) => importer.addFiles(filePaths))
  handle('import:getImportProgress', (jobId: string) => importer.getImportProgress(jobId))
  handle('import:resolveDuplicate', (jobId: string, decision: DuplicateDecision) =>
    importer.resolveDuplicate(jobId, decision)
  )
}
