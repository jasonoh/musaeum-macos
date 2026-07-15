import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { extname, join } from 'path'
import type { Book, BookFormat, ReadStatus } from '@shared/book.types'
import type {
  MigrationJob,
  MigrationOptions,
  MigrationProgress,
  MigrationScan
} from '@shared/metadata.types'
import * as db from './db'
import { broadcast } from './events'
import * as nasManager from './nas-manager'
import * as sidecar from './sidecar'

const BOOK_EXTENSIONS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])

const jobs = new Map<string, MigrationProgress>()
let pendingCutoverRoot: string | null = null

export function getMigrationProgress(jobId: string): MigrationProgress | null {
  return jobs.get(jobId) ?? null
}

/**
 * Read-only scan of a Calibre library: counts book files and checks for
 * metadata.db. Never modifies the source library.
 */
export async function scanCalibreLibrary(calibrePath: string): Promise<MigrationScan> {
  const formatCounts: Record<string, number> = {}
  let bookCount = 0
  let sizeBytes = 0

  // Calibre layout: {library}/{Author}/{Title (id)}/files
  const authors = await fs.readdir(calibrePath, { withFileTypes: true })
  for (const author of authors) {
    if (!author.isDirectory() || author.name.startsWith('.')) continue
    const authorDir = join(calibrePath, author.name)
    let titles
    try {
      titles = await fs.readdir(authorDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const title of titles) {
      if (!title.isDirectory()) continue
      const titleDir = join(authorDir, title.name)
      let files: string[]
      try {
        files = await fs.readdir(titleDir)
      } catch {
        continue
      }
      let hasBook = false
      for (const f of files) {
        const ext = extname(f).toLowerCase()
        if (!BOOK_EXTENSIONS.has(ext)) continue
        hasBook = true
        formatCounts[ext.slice(1)] = (formatCounts[ext.slice(1)] ?? 0) + 1
        try {
          sizeBytes += (await fs.stat(join(titleDir, f))).size
        } catch {
          /* unreadable file — skip from size estimate */
        }
      }
      if (hasBook) bookCount++
    }
  }

  const hasMetadataDb = await fs
    .access(join(calibrePath, 'metadata.db'))
    .then(() => true)
    .catch(() => false)

  return { calibrePath, bookCount, formatCounts, hasMetadataDb, estimatedSizeBytes: sizeBytes }
}

interface MigratedBookRecord {
  id: string
  title: string
  sort_title?: string
  author?: string
  author_sort?: string
  publisher?: string
  published_date?: string
  language?: string
  description?: string
  identifiers?: Record<string, string>
  series?: { name: string; index: number; total?: number } | null
  tags?: string[]
  rating?: number | null
  formats: string[]
  cover_thumb?: string
  cover_full?: string
  file_size_bytes?: number
  needs_review?: boolean
  read_status?: string
}

/**
 * Full migration, orchestrated by the Python sidecar (migrate_library).
 * The sidecar copies files into the target structure and streams progress
 * notifications; the original Calibre library is never modified. On success
 * we bulk-insert the results into the SQLite cache. Cutover to the new
 * library root only happens on explicit confirmCutover().
 */
export function startMigration(options: MigrationOptions): MigrationJob {
  if (options.calibrePath === options.targetLibraryRoot) {
    throw new Error('Target library must be a different folder than the Calibre library')
  }
  const jobId = randomUUID()
  const progress: MigrationProgress = {
    jobId,
    phase: 'scanning',
    total: 0,
    completed: 0,
    migrated: 0,
    needsReview: 0,
    noMetadata: 0,
    duplicates: 0,
    currentTitle: null
  }
  jobs.set(jobId, progress)

  sidecar.onNotification('migration_progress', (params) => {
    const p = params as Partial<MigrationProgress> & { job_id?: string }
    if (p.job_id !== jobId) return
    Object.assign(progress, {
      phase: p.phase ?? progress.phase,
      total: p.total ?? progress.total,
      completed: p.completed ?? progress.completed,
      migrated: p.migrated ?? progress.migrated,
      needsReview: p.needsReview ?? progress.needsReview,
      noMetadata: p.noMetadata ?? progress.noMetadata,
      duplicates: p.duplicates ?? progress.duplicates,
      currentTitle: p.currentTitle ?? progress.currentTitle
    })
  })

  void (async () => {
    try {
      const result = await sidecar.call<{ books: MigratedBookRecord[] }>(
        'migrate_library',
        {
          job_id: jobId,
          calibre_path: options.calibrePath,
          target_root: options.targetLibraryRoot,
          hydrate: options.hydrate,
          ebook_convert_path: sidecar.ebookConvertPath()
        },
        // Migrating thousands of books takes hours
        1000 * 60 * 60 * 12
      )
      insertMigratedBooks(result.books)
      pendingCutoverRoot = options.targetLibraryRoot
      progress.phase = 'done'
      broadcast('libraryChanged')
    } catch (err) {
      progress.phase = 'error'
      progress.error = err instanceof Error ? err.message : String(err)
    }
  })()

  return { jobId }
}

function insertMigratedBooks(records: MigratedBookRecord[]): void {
  const now = new Date().toISOString()
  for (const r of records) {
    const book: Book = {
      id: r.id,
      title: r.title,
      sortTitle: r.sort_title ?? null,
      author: r.author ?? null,
      authorSort: r.author_sort ?? null,
      publisher: r.publisher ?? null,
      publishedDate: r.published_date ?? null,
      language: r.language ?? null,
      description: r.description ?? null,
      isbn10: r.identifiers?.isbn_10 ?? null,
      isbn13: r.identifiers?.isbn_13 ?? null,
      goodreadsId: r.identifiers?.goodreads ?? null,
      openlibraryId: r.identifiers?.openlibrary ?? null,
      seriesName: r.series?.name ?? null,
      seriesIndex: r.series?.index ?? null,
      seriesTotal: r.series?.total ?? null,
      coverThumbPath: r.cover_thumb ?? null,
      coverFullPath: r.cover_full ?? null,
      formats: (r.formats ?? []) as BookFormat[],
      tags: r.tags ?? [],
      rating: r.rating ?? null,
      dateAdded: now,
      lastModified: now,
      fileSizeBytes: r.file_size_bytes ?? null,
      readStatus: (r.read_status ?? 'unread') as ReadStatus,
      nasPath: join('books', r.id)
    }
    try {
      db.insertBook(book)
    } catch (err) {
      console.error(`[migration] failed to insert ${r.title}:`, err)
    }
  }
}

/** Point the app at the migrated library. Explicit, user-confirmed. */
export async function confirmCutover(): Promise<void> {
  if (!pendingCutoverRoot) throw new Error('No completed migration awaiting cutover')
  await nasManager.setLibraryRoot(pendingCutoverRoot)
  pendingCutoverRoot = null
  broadcast('libraryChanged')
}
