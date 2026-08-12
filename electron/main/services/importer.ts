import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import type {
  Book,
  BookFormat,
  DuplicateContext,
  DuplicateDecision,
  DuplicateMatchType,
  ImportProgress,
  ImportResult,
  ImportStep
} from '@shared/book.types'
import { sortableAuthor, sortableTitle } from '@shared/book.types'
import type { ConflictCandidate } from '@shared/metadata.types'
import * as bookFiles from './book-files'
import * as db from './db'
import { broadcast } from './events'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'
import { sanitizeTitle } from './sanitize'

export { sanitizeTitle }

const SUPPORTED_FORMATS = new Set(['.epub', '.mobi', '.azw3', '.pdf'])

const jobs = new Map<string, ImportProgress>()

const pendingDecisions = new Map<string, (d: DuplicateDecision) => void>()

export function resolveDuplicate(jobId: string, decision: DuplicateDecision): void {
  const resolver = pendingDecisions.get(jobId)
  if (!resolver) return
  pendingDecisions.delete(jobId)
  resolver(decision)
}

/** Resolve every pending gate as Skip — call on shutdown so import loops unwind. */
export function abortPendingDecisions(): void {
  for (const [id, resolve] of pendingDecisions) {
    pendingDecisions.delete(id)
    resolve({ action: 'skip' })
  }
}

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

    // 2. Duplicate GATE — ISBN-13 or normalized title+author blocks import
    let existing: Book | null = null
    let matchType: DuplicateMatchType | null = null
    if (isbn13) {
      const dup = db.findByIsbn13(isbn13)
      if (dup) {
        existing = dup
        matchType = 'isbn'
      }
    }
    if (!existing) {
      const dup = db.findByTitleAuthor(title, author)
      if (dup) {
        existing = dup
        matchType = 'title_author'
      }
    }

    if (existing && matchType) {
      const duplicateContext: DuplicateContext = {
        existingBookId: existing.id,
        existingTitle: existing.title,
        existingAuthor: existing.author,
        matchType
      }
      emit(job, 'awaiting_dedup_decision', { duplicate: duplicateContext })
      const decision = await new Promise<DuplicateDecision>((resolve) =>
        pendingDecisions.set(jobId, resolve)
      )
      if (decision.action === 'skip') {
        emit(job, 'skipped')
        return { jobId, fileName, success: false, skipped: true, action: 'skip' }
      }
      if (decision.action === 'add_format') {
        return await addFormatToExisting(existing, filePath, ext, format, job, fileName)
      }
      // 'add_new' → fall through to the unchanged copy/insert/hydrate pipeline
    }

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
      authorSort: extracted.authors?.[0]?.sort ?? sortableAuthor(author),
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

    return { jobId, fileName, success: true, bookId }
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
      // Files were named from the pre-hydration title — often the filename, or
      // whatever a mispackaged EPUB claimed. Now that the title is settled, the
      // files follow it.
      await bookFiles.renameToTitle(bookDir, updated.title)
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
  if (m.sort_title || m.title) updates.sortTitle = m.sort_title ?? sortableTitle(m.title!)
  if (m.authors?.length) {
    updates.author = m.authors[0].name
    updates.authorSort = m.authors[0].sort ?? sortableAuthor(m.authors[0].name)
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

async function addFormatToExisting(
  existing: Book,
  srcPath: string,
  ext: string,
  format: BookFormat,
  job: ImportProgress,
  fileName: string
): Promise<ImportResult> {
  if (!existing.nasPath) throw new Error('Existing book has no NAS path')
  emit(job, 'copying', { bookId: existing.id })
  const bookDir = join(nas.getLibraryRoot()!, existing.nasPath)
  await fs.mkdir(bookDir, { recursive: true })
  // Overwrite semantics: delete EVERY existing file of this extension first,
  // then write under the existing book's canonical name — prevents two
  // same-extension files (findFormatFile picks nondeterministically otherwise).
  for (const f of await fs.readdir(bookDir)) {
    if (extname(f).toLowerCase() === ext) await fs.rm(join(bookDir, f), { force: true })
  }
  await fs.copyFile(srcPath, join(bookDir, `${sanitizeTitle(existing.title)}${ext}`))
  const formats = [...new Set([...existing.formats, format])]
  db.updateBook(existing.id, { formats })
  const updated = db.getBook(existing.id)!
  await writeMetadataJson(bookDir, updated)
  librarySync.upsertCatalog([updated])
  broadcast('libraryChanged')
  emit(job, 'done', { bookId: existing.id })
  return { jobId: job.jobId, fileName, success: true, bookId: existing.id, action: 'add_format' }
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
