import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import type { Book, BookFormat, ImportProgress, ImportResult, ImportStep } from '@shared/book.types'
import type { ConflictCandidate } from '@shared/metadata.types'
import * as db from './db'
import { broadcast } from './events'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

const SUPPORTED_FORMATS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])

const jobs = new Map<string, ImportProgress>()

export function getImportProgress(jobId: string): ImportProgress | null {
  return jobs.get(jobId) ?? null
}

interface ExtractedMetadata {
  title?: string
  authors?: { name: string; sort?: string }[]
  publisher?: string
  published_date?: string
  language?: string
  description?: string
  identifiers?: Record<string, string>
}

interface HydrationResult {
  metadata: {
    title?: string
    sort_title?: string
    authors?: { name: string; sort?: string }[]
    publisher?: string
    published_date?: string
    language?: string
    description?: string
    identifiers?: Record<string, string>
    series?: { name: string; index: number; total?: number } | null
    tags?: string[]
    metadata_sources?: Record<string, { fetched_at: string; match_confidence: number }>
  }
  conflicts: { field: string; candidates: ConflictCandidate[] }[]
  cover: { full: string; thumb: string; source: string; width: number; height: number } | null
}

function emit(job: ImportProgress, step: ImportStep, extra?: Partial<ImportProgress>): void {
  Object.assign(job, extra, { step })
  jobs.set(job.jobId, job)
  broadcast('importProgress', { ...job })
}

/** Strip filesystem-hostile characters; cap length for NAS friendliness. */
export function sanitizeTitle(title: string): string {
  const clean = title
    .replace(/[/\\:*?"<>|]/g, '')
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (clean || 'untitled').slice(0, 80)
}

function titleFromFilename(filePath: string): string {
  return basename(filePath, extname(filePath)).replace(/[_.]+/g, ' ').trim()
}

export async function addFiles(filePaths: string[]): Promise<ImportResult[]> {
  const results: ImportResult[] = []
  for (const filePath of filePaths) {
    results.push(await importOne(filePath))
  }
  return results
}

async function importOne(filePath: string): Promise<ImportResult> {
  const jobId = randomUUID()
  const fileName = basename(filePath)
  const job: ImportProgress = { jobId, fileName, bookId: null, step: 'received' }
  emit(job, 'received')

  try {
    nas.assertOnline()
    const ext = extname(filePath).toLowerCase()
    if (!SUPPORTED_FORMATS.has(ext)) {
      throw new Error(`Unsupported format: ${ext || '(no extension)'}`)
    }
    const format = ext.slice(1) as BookFormat
    const libraryRoot = nas.getLibraryRoot()!
    const stat = await fs.stat(filePath)

    // 1. Extract embedded metadata (EPUB/PDF; other formats fall back to filename)
    emit(job, 'extracting')
    let extracted: ExtractedMetadata = {}
    const extractMethod =
      format === 'epub' ? 'extract_epub_metadata' : format === 'pdf' ? 'extract_pdf_metadata' : null
    if (extractMethod && sidecar.isAvailable()) {
      try {
        extracted = await sidecar.call<ExtractedMetadata>(
          extractMethod,
          { file_path: filePath },
          30_000
        )
      } catch (err) {
        console.error('[import] extraction failed, falling back to filename:', err)
      }
    }
    const title = extracted.title?.trim() || titleFromFilename(filePath)
    const author = extracted.authors?.[0]?.name ?? null
    const isbn13 = extracted.identifiers?.isbn_13 ?? null

    // 2. Duplicate detection — ISBN match is definitive, title+author warns
    emit(job, 'duplicate_check')
    let duplicateWarning: string | undefined
    if (isbn13) {
      const dup = db.findByIsbn13(isbn13)
      if (dup) duplicateWarning = `Already in library (ISBN match): “${dup.title}”`
    }
    if (!duplicateWarning) {
      const dup = db.findByTitleAuthor(title, author)
      if (dup) duplicateWarning = `Possible duplicate of “${dup.title}”${dup.author ? ` by ${dup.author}` : ''}`
    }
    if (duplicateWarning) emit(job, 'duplicate_check', { duplicateWarning })

    // 3. Copy into books/{uuid}/ on the NAS
    emit(job, 'copying')
    const bookId = randomUUID()
    const bookDir = join(libraryRoot, 'books', bookId)
    await fs.mkdir(bookDir, { recursive: true })
    const targetFile = join(bookDir, `${sanitizeTitle(title)}${ext}`)
    await fs.copyFile(filePath, targetFile)

    // 4. Insert into cache — the book is in the library from this moment;
    //    hydration continues async and never blocks import
    const now = new Date().toISOString()
    const book: Book = {
      id: bookId,
      title,
      sortTitle: sortableTitle(title),
      author,
      authorSort: extracted.authors?.[0]?.sort ?? null,
      publisher: extracted.publisher ?? null,
      publishedDate: extracted.published_date ?? null,
      language: extracted.language ?? null,
      description: extracted.description ?? null,
      isbn10: extracted.identifiers?.isbn_10 ?? null,
      isbn13,
      goodreadsId: extracted.identifiers?.goodreads ?? null,
      openlibraryId: extracted.identifiers?.openlibrary ?? null,
      seriesName: null,
      seriesIndex: null,
      seriesTotal: null,
      coverThumbPath: null,
      coverFullPath: null,
      formats: [format],
      tags: [],
      rating: null,
      dateAdded: now,
      lastModified: now,
      fileSizeBytes: stat.size,
      readStatus: 'unread',
      nasPath: join('books', bookId)
    }
    db.insertBook(book)
    await writeMetadataJson(bookDir, book)
    broadcast('libraryChanged')
    librarySync.upsertCatalog([book])

    emit(job, 'hydrating', { bookId })
    void hydrate(bookId, targetFile, bookDir, job)

    return { jobId, fileName, success: true, bookId, duplicateWarning }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit(job, 'error', { error: message })
    return { jobId, fileName, success: false, error: message }
  }
}

/** Async hydration: online metadata fetch, conflict queueing, cover selection. */
export async function hydrate(
  bookId: string,
  filePath: string,
  bookDir: string,
  job?: ImportProgress
): Promise<void> {
  const book = db.getBook(bookId)
  if (!book) return

  try {
    const result = await sidecar.call<HydrationResult>(
      'hydrate_metadata',
      {
        book_id: bookId,
        file_path: filePath,
        book_dir: bookDir,
        known: {
          title: book.title,
          author: book.author,
          identifiers: {
            isbn_10: book.isbn10 ?? undefined,
            isbn_13: book.isbn13 ?? undefined,
            goodreads: book.goodreadsId ?? undefined,
            openlibrary: book.openlibraryId ?? undefined
          }
        },
        source_preferences: db.getSourcePreferences()
      },
      300_000
    )

    if (job) emit(job, 'cover')
    applyHydration(bookId, result)

    const updated = db.getBook(bookId)
    if (updated) {
      await writeMetadataJson(bookDir, updated, result.metadata.metadata_sources)
      librarySync.upsertCatalog([updated])
    }

    if (result.conflicts.length) {
      broadcast('conflictQueueUpdated', db.getUnresolvedConflictCount())
    }
    broadcast('libraryChanged')
    if (job) emit(job, 'done')
  } catch (err) {
    // Hydration failure is non-fatal — the book stays with embedded metadata
    console.error(`[import] hydration failed for ${bookId}:`, err)
    if (job) emit(job, 'done')
  }
}

function applyHydration(bookId: string, result: HydrationResult): void {
  const m = result.metadata
  const updates: Partial<Book> = {}
  if (m.title) updates.title = m.title
  if (m.sort_title) updates.sortTitle = m.sort_title
  if (m.authors?.length) {
    updates.author = m.authors[0].name
    updates.authorSort = m.authors[0].sort ?? null
  }
  if (m.publisher) updates.publisher = m.publisher
  if (m.published_date) updates.publishedDate = m.published_date
  if (m.language) updates.language = m.language
  if (m.description) updates.description = m.description
  if (m.identifiers) {
    if (m.identifiers.isbn_10) updates.isbn10 = m.identifiers.isbn_10
    if (m.identifiers.isbn_13) updates.isbn13 = m.identifiers.isbn_13
    if (m.identifiers.goodreads) updates.goodreadsId = m.identifiers.goodreads
    if (m.identifiers.openlibrary) updates.openlibraryId = m.identifiers.openlibrary
  }
  if (m.series) {
    updates.seriesName = m.series.name
    updates.seriesIndex = m.series.index
    updates.seriesTotal = m.series.total ?? null
  }
  if (m.tags?.length) updates.tags = m.tags
  if (result.cover) {
    updates.coverFullPath = result.cover.full
    updates.coverThumbPath = result.cover.thumb
  }
  db.updateBook(bookId, updates)

  for (const conflict of result.conflicts) {
    db.insertConflict(bookId, conflict.field, conflict.candidates)
  }
}

/** "The Great Gatsby" → "Great Gatsby, The" */
function sortableTitle(title: string): string {
  const m = title.match(/^(The|A|An)\s+(.+)$/i)
  return m ? `${m[2]}, ${m[1]}` : title
}

export async function writeMetadataJson(
  bookDir: string,
  book: Book,
  sources?: Record<string, { fetched_at: string; match_confidence: number }>
): Promise<void> {
  const json = {
    id: book.id,
    title: book.title,
    sort_title: book.sortTitle,
    authors: book.author ? [{ name: book.author, sort: book.authorSort }] : [],
    publisher: book.publisher,
    published_date: book.publishedDate,
    language: book.language,
    description: book.description,
    identifiers: {
      isbn_10: book.isbn10,
      isbn_13: book.isbn13,
      goodreads: book.goodreadsId,
      openlibrary: book.openlibraryId
    },
    series: book.seriesName
      ? { name: book.seriesName, index: book.seriesIndex, total: book.seriesTotal }
      : null,
    tags: book.tags,
    cover: book.coverFullPath
      ? { full: book.coverFullPath, thumb: book.coverThumbPath }
      : null,
    formats: book.formats,
    rating: book.rating,
    read_status: book.readStatus,
    date_added: book.dateAdded,
    last_modified: book.lastModified,
    ...(sources ? { metadata_sources: sources } : {})
  }
  await fs.writeFile(join(bookDir, 'metadata.json'), JSON.stringify(json, null, 2), 'utf8')
}
