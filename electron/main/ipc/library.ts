import { dialog } from 'electron'
import type { Book, BookFilters, BookFormat, BookSort, DuplicateDecision } from '@shared/book.types'
import { bookFileFilter } from '@shared/book.types'
import type { HydratedField } from '@shared/metadata.types'
import * as bookDelete from '../services/book-delete'
import * as db from '../services/db'
import * as fieldOverrides from '../services/field-overrides'
import * as importer from '../services/importer'
import * as libraryEdit from '../services/library-edit'
import * as librarySync from '../services/library-sync'
import { handle } from './handle'

export function registerLibraryHandlers(): void {
  handle('library:getBooks', (filters?: BookFilters) => db.getBooks(filters))

  handle('library:getBook', (id: string) => {
    const book = db.getBook(id)
    if (!book) throw new Error('Book not found')
    return book
  })

  // The fields the user has set, which a fetch must not touch. Read by the
  // editor so it can show them; released one at a time, which never changes the
  // value (design D2).
  handle('library:getFieldOverrides', (id: string) => fieldOverrides.list(id))

  handle('library:releaseFieldOverride', (id: string, field: HydratedField) =>
    fieldOverrides.release(id, field)
  )

  handle('library:searchBooks', (query: string, sort?: BookSort) => db.searchBooks(query, sort))

  handle('library:getFacets', () => db.getFacets())

  handle('library:refreshLibrary', () => librarySync.refreshLibrary())
  handle('library:rebuildCatalog', () => librarySync.rebuildCatalog())
  // Cancels a *rebuild*; a plain refresh is a catalog read with nothing to stop
  handle('library:cancelRefresh', () => librarySync.cancelRefresh())

  handle('library:updateBook', (id: string, updates: Partial<Book>) =>
    libraryEdit.updateBook(id, updates)
  )

  handle('library:deleteBook', (id: string) => bookDelete.deleteBook(id))

  handle('library:deleteBooks', (ids: string[]) => bookDelete.deleteBooks(ids))

  handle('library:deleteFormats', (id: string, formats: BookFormat[]) =>
    bookDelete.deleteFormats(id, formats)
  )

  // Import lives in the library domain
  handle('import:addFiles', (filePaths: string[]) => importer.addFiles(filePaths))
  handle('import:getImportProgress', (jobId: string) => importer.getImportProgress(jobId))
  handle('import:resolveDuplicate', (jobId: string, decision: DuplicateDecision) =>
    importer.resolveDuplicate(jobId, decision)
  )

  /**
   * The app's first book-file picker — the only route into the library that
   * isn't a drag or a Finder association. It exists in main because the
   * renderer may not open a native dialog, and because the renderer never gets
   * a `file://` path it made itself (`CLAUDE.md` #9): the paths the user picks
   * are handed back and then go through `import:addFiles` like any other.
   *
   * The filter comes from `bookFileFilter()`, derived from `BookFormat`, so the
   * picker and the drag-drop gate are one list. A cancelled dialog answers with
   * an empty list rather than null: the caller's next step is a batch import,
   * and an empty batch is already the no-op.
   */
  handle('import:fromDialog', async (): Promise<string[]> => {
    const result = await dialog.showOpenDialog({
      title: 'Add Books',
      message: 'Select the book files to import',
      properties: ['openFile', 'multiSelections'],
      filters: [bookFileFilter()]
    })
    return result.canceled ? [] : result.filePaths
  })
}
