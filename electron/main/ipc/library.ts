import { promises as fs } from 'fs'
import { join } from 'path'
import type { Book, BookFilters } from '@shared/book.types'
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

  handle('library:searchBooks', (query: string) => db.searchBooks(query))

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
      await importer.writeMetadataJson(join(nas.getLibraryRoot()!, book.nasPath), book)
      librarySync.upsertCatalog([book])
    }
    broadcast('libraryChanged')
  })

  handle('library:deleteBook', async (id: string) => {
    nas.assertOnline()
    const book = db.getBook(id)
    if (book?.nasPath) {
      await fs.rm(join(nas.getLibraryRoot()!, book.nasPath), { recursive: true, force: true })
    }
    db.deleteBook(id)
    librarySync.removeBookFromCatalog(id)
    broadcast('libraryChanged')
  })

  // Import lives in the library domain
  handle('import:addFiles', (filePaths: string[]) => importer.addFiles(filePaths))
  handle('import:getImportProgress', (jobId: string) => importer.getImportProgress(jobId))
}
