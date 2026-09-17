import { join } from 'path'
import type { Book } from '@shared/book.types'
import type { ConflictChoices } from '@shared/metadata.types'
import * as bookFiles from './book-files'
import * as db from './db'
import { broadcast } from './events'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/** Conflict fields map onto Book columns; series is a JSON-encoded value. */
const FIELD_TO_BOOK_KEY: Record<string, keyof Book> = {
  title: 'title',
  author: 'author',
  publisher: 'publisher',
  published_date: 'publishedDate',
  description: 'description',
  language: 'language'
}

/**
 * Apply the chosen candidate for one queued conflict, then settle the book.
 * Mirrors `metadata:resolveConflict`'s previous inline body verbatim — see
 * `docs/invariants/conflicts-and-series.md` and
 * `docs/invariants/files-and-deletion.md` for why the rename leg runs here.
 */
export async function resolveConflict(conflictId: number, choices: ConflictChoices): Promise<void> {
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
    const bookDir = join(nas.getLibraryRoot()!, book.nasPath)
    await importer.writeMetadataJson(bookDir, book)
    // A title resolution is the third place a title settles, after hydration
    // and the metadata editor — and the only one that forgot the files, which
    // left a book renamed to "After the Quake" holding "The Bakery Attack.epub"
    // on disk. Never throws; see book-files.ts.
    await bookFiles.renameToTitle(bookDir, book.title)
    librarySync.upsertCatalog([book])
  }

  broadcast('conflictQueueUpdated', db.getUnresolvedConflictCount())
  broadcast('libraryChanged')
}
