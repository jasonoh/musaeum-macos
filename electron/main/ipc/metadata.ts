import { join } from 'path'
import type { Book } from '@shared/book.types'
import type { ConflictChoices } from '@shared/metadata.types'
import * as bulkHydrate from '../services/bulk-hydrate'
import * as db from '../services/db'
import { broadcast } from '../services/events'
import * as importer from '../services/importer'
import * as librarySync from '../services/library-sync'
import * as nas from '../services/nas-manager'
import * as sidecar from '../services/sidecar'
import { handle } from './handle'

/** Conflict fields map onto Book columns; series is a JSON-encoded value. */
const FIELD_TO_BOOK_KEY: Record<string, keyof Book> = {
  title: 'title',
  author: 'author',
  publisher: 'publisher',
  published_date: 'publishedDate',
  description: 'description',
  language: 'language'
}

export function registerMetadataHandlers(): void {
  handle('metadata:getConflictQueue', () => db.getConflictQueue())

  handle('metadata:resolveConflict', async (conflictId: number, choices: ConflictChoices) => {
    const conflict = db.getConflict(conflictId)
    if (!conflict) throw new Error('Conflict not found')

    const chosenSource = choices[conflict.field]
    if (!chosenSource) throw new Error(`No choice provided for field "${conflict.field}"`)
    const candidate = conflict.candidates.find((c) => c.source === chosenSource)
    if (!candidate) throw new Error(`Source "${chosenSource}" is not a candidate for this conflict`)

    const updates: Partial<Book> = {}
    if (conflict.field === 'cover') {
      // Cover candidates carry the image URL; download + rewrite via sidecar
      const current = db.getBook(conflict.bookId)
      if (!current?.nasPath) throw new Error('Book not found')
      nas.assertOnline()
      const cover = await sidecar.call<{ full: string; thumb: string }>('fetch_cover', {
        book_dir: join(nas.getLibraryRoot()!, current.nasPath),
        url: candidate.value,
        source: chosenSource
      })
      updates.coverFullPath = cover.full
      updates.coverThumbPath = cover.thumb
    } else if (conflict.field === 'series') {
      const series = JSON.parse(candidate.value) as { name: string; index: number; total?: number }
      updates.seriesName = series.name
      updates.seriesIndex = series.index
      updates.seriesTotal = series.total ?? null
    } else if (conflict.field === 'tags') {
      updates.tags = JSON.parse(candidate.value) as string[]
    } else {
      const key = FIELD_TO_BOOK_KEY[conflict.field]
      if (!key) throw new Error(`Unknown conflict field "${conflict.field}"`)
      ;(updates as Record<string, unknown>)[key] = candidate.value
    }

    db.updateBook(conflict.bookId, updates)
    db.markConflictResolved(conflictId, chosenSource)

    const book = db.getBook(conflict.bookId)
    if (book?.nasPath && nas.isOnline()) {
      await importer.writeMetadataJson(join(nas.getLibraryRoot()!, book.nasPath), book)
      librarySync.upsertCatalog([book])
    }

    broadcast('conflictQueueUpdated', db.getUnresolvedConflictCount())
    broadcast('libraryChanged')
  })

  handle('metadata:rehydrateBook', async (bookId: string) => {
    nas.assertOnline()
    const book = db.getBook(bookId)
    if (!book?.nasPath) throw new Error('Book not found')
    const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
    const file = await bulkHydrate.findHydratableFile(bookDir)
    if (!file) throw new Error('No book file found to hydrate from')
    // Fire and forget — hydration is always non-blocking
    void importer.hydrate(bookId, file, bookDir)
  })

  handle('metadata:rehydrateBooks', (bookIds: string[]) => {
    bulkHydrate.startBulkHydrate(bookIds)
  })

  handle('metadata:cancelRehydrate', () => {
    bulkHydrate.cancelBulkHydrate()
  })
}
