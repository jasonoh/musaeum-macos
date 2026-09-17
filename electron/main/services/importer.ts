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
import type { ConflictCandidate, HydratedField, HydrateOutcome } from '@shared/metadata.types'
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

// Per-process counter giving each writeMetadataJson call a unique scratch
// file name (see the comment at its use site for why a fixed name, as
// writeCatalog uses, is unsafe here).
let scratchCounter = 0
function nextScratchId(): number {
  scratchCounter += 1
  return scratchCounter
}

/**
 * Test-only: the id `writeMetadataJson`'s *next* call will use, without
 * consuming it. Lets tests that simulate an interrupted write (by occupying
 * the scratch path ahead of time, e.g. as a directory) predict the exact
 * unique path a real call will pick, since it's no longer a fixed name.
 */
export function peekNextScratchId(): number {
  return scratchCounter + 1
}

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
  cover: {
    full: string
    thumb: string
    source: string
    width: number
    height: number
    /** Present since the feedback work; absent on a sidecar that predates it. */
    changed?: boolean
  } | null
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
      nasPath: join('books', bookId),
      readingState: null
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

/**
 * Async hydration: online metadata fetch, conflict queueing, cover selection.
 *
 * Returns what it did rather than only logging it. Callers that treat
 * hydration as fire-and-forget (import) ignore the value; the explicit
 * re-fetch behind the metadata-refresh button waits for it and reports it.
 * A failure is part of that value — never a throw — because a failed
 * hydration is non-fatal by design: the book keeps its embedded metadata.
 */
export async function hydrate(
  bookId: string,
  filePath: string,
  bookDir: string,
  job?: ImportProgress,
  /**
   * Batched: the caller owns the catalog write and the libraryChanged
   * broadcast for the whole run. metadata.json is still written per book —
   * it is the canonical store and lives in the book's own folder, which is
   * exactly what catalog.json is not.
   */
  options: { batched?: boolean } = {}
): Promise<HydrateOutcome> {
  const book = db.getBook(bookId)
  if (!book) return { ok: false, error: 'Book not found' }

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
    const changed = applyHydration(bookId, result)

    const updated = db.getBook(bookId)
    if (updated) {
      await writeMetadataJson(bookDir, updated, result.metadata.metadata_sources)
      if (!options.batched) librarySync.upsertCatalog([updated])
      // Files were named from the pre-hydration title — often the filename, or
      // whatever a mispackaged EPUB claimed. Now that the title is settled, the
      // files follow it.
      await bookFiles.renameToTitle(bookDir, updated.title)
    }

    if (result.conflicts.length) {
      broadcast('conflictQueueUpdated', db.getUnresolvedConflictCount())
    }
    if (!options.batched) broadcast('libraryChanged')
    if (job) emit(job, 'done')
    return { ok: true, changed, conflicts: result.conflicts.length }
  } catch (err) {
    // Hydration failure is non-fatal — the book stays with embedded metadata
    console.error(`[import] hydration failed for ${bookId}:`, err)
    if (job) emit(job, 'done')
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The `books` columns hydration writes, mapped to the user-facing field each
 * one belongs to. Several columns are one field — the four identifier columns
 * are a single "identifiers" — so this map is what lets the refresh report read
 * "Title, cover and series" instead of naming columns.
 *
 * Only columns whose own value is what the user sees are listed. `sort_title`
 * and `author_sort` are derived from `title` and `author` and are written
 * through the same path, but a book whose sort key was only ever backfilled
 * has not had its title changed, and reporting it as such would put "Title"
 * on every refresh of every book that arrived without one.
 */
const HYDRATED_KEY_FIELD: Partial<Record<keyof Book, HydratedField>> = {
  title: 'title',
  coverFullPath: 'cover',
  coverThumbPath: 'cover',
  author: 'author',
  seriesName: 'series',
  seriesIndex: 'series',
  seriesTotal: 'series',
  description: 'description',
  publisher: 'publisher',
  publishedDate: 'published_date',
  language: 'language',
  isbn10: 'identifiers',
  isbn13: 'identifiers',
  goodreadsId: 'identifiers',
  openlibraryId: 'identifiers',
  tags: 'tags'
}

/** Reference compare, except arrays (tags), which are compared by value. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/** Applies a hydration result; returns the fields whose value really changed. */
function applyHydration(bookId: string, result: HydrationResult): HydratedField[] {
  const before = db.getBook(bookId)
  if (!before) return []
  const m = result.metadata
  const updates: Partial<Book> = {}
  const changed = new Set<HydratedField>()

  const set = (key: keyof Book, value: Book[keyof Book]): void => {
    const field = HYDRATED_KEY_FIELD[key]
    if (field && !sameValue(before[key], value)) changed.add(field)
    ;(updates as Record<string, unknown>)[key] = value
  }

  if (m.title) set('title', m.title)
  if (m.sort_title || m.title) set('sortTitle', m.sort_title ?? sortableTitle(m.title!))
  if (m.authors?.length) {
    set('author', m.authors[0].name)
    set('authorSort', m.authors[0].sort ?? sortableAuthor(m.authors[0].name))
  }
  if (m.publisher) set('publisher', m.publisher)
  if (m.published_date) set('publishedDate', m.published_date)
  if (m.language) set('language', m.language)
  if (m.description) set('description', m.description)
  if (m.identifiers) {
    if (m.identifiers.isbn_10) set('isbn10', m.identifiers.isbn_10)
    if (m.identifiers.isbn_13) set('isbn13', m.identifiers.isbn_13)
    if (m.identifiers.goodreads) set('goodreadsId', m.identifiers.goodreads)
    if (m.identifiers.openlibrary) set('openlibraryId', m.identifiers.openlibrary)
  }
  if (m.series) {
    set('seriesName', m.series.name)
    set('seriesIndex', m.series.index)
    set('seriesTotal', m.series.total ?? null)
  }
  if (m.tags?.length) set('tags', m.tags)
  if (result.cover) {
    // The paths are fixed names, so they say nothing about whether the artwork
    // changed — the sidecar compares the bytes it is about to write and says
    // so. Falling back to the path diff keeps this honest against a sidecar
    // too old to report it (a first cover is a change either way).
    const coverChanged = result.cover.changed ?? before.coverFullPath !== result.cover.full
    set('coverFullPath', result.cover.full)
    set('coverThumbPath', result.cover.thumb)
    if (coverChanged) changed.add('cover')
  }
  db.updateBook(bookId, updates)

  for (const conflict of result.conflicts) {
    db.insertConflict(bookId, conflict.field, conflict.candidates)
  }
  return [...changed]
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
  // Recompute rather than add: file_size_bytes is set at import and never
  // revisited otherwise, so an increment on top of a possibly-stale value would
  // just carry the drift forward. Non-fatal — a readdir/stat failure on a flaky
  // share keeps the previous value rather than failing the import.
  const fileSizeBytes = (await bookFiles.computeFileSizeBytes(bookDir)) ?? existing.fileSizeBytes
  db.updateBook(existing.id, { formats, fileSizeBytes })
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
    cover: book.coverFullPath ? { full: book.coverFullPath, thumb: book.coverThumbPath } : null,
    formats: book.formats,
    rating: book.rating,
    read_status: book.readStatus,
    reading_state: book.readingState
      ? {
          position: book.readingState.position,
          percent: book.readingState.percent,
          updated_at: book.readingState.updatedAt
        }
      : null,
    date_added: book.dateAdded,
    last_modified: book.lastModified,
    ...(sources ? { metadata_sources: sources } : {})
  }
  // Atomic write: .part then rename, exactly as catalog.ts's writeCatalog —
  // and more load-bearing here, because metadata.json is the canonical record
  // while the catalog is a derived cache. Reading position rewrites this file
  // every 30s of reading and again at quit, where the flush timeout
  // deliberately lets the process exit with an SMB write possibly mid-flight;
  // a torn file then fails JSON.parse in `rebuildFromBookDirs`, which skips
  // the folder — so the book disappears from the rebuilt catalog entirely.
  //
  // Unlike writeCatalog, this scratch name cannot be fixed: catalog writes are
  // serialized through one promise queue (`catalog.ts`'s `enqueue`), so only
  // one writer ever touches `catalog.json.part` at a time. metadata.json has
  // no such queue — `reading:saveProgress` is unserialized, and its
  // `lastJsonWrite` bookkeeping updates only after the await, so two page
  // turns in the same session can both see themselves as "first" and both
  // write the same book's metadata.json concurrently. A shared scratch path
  // would let a second writer's rename land on a file the first is still
  // mid-write into — the exact torn-file failure this atomic write exists to
  // prevent. Suffixing with the pid and a per-process counter keeps every
  // writer, in this process or another, on its own scratch file.
  const target = join(bookDir, 'metadata.json')
  const scratch = `${target}.${process.pid}.${nextScratchId()}.part`
  await fs.writeFile(scratch, JSON.stringify(json, null, 2), 'utf8')
  try {
    await fs.rename(scratch, target)
  } catch (err) {
    // Best-effort cleanup only — never mask the original rename error, and
    // never throw a second error out of a catch block.
    await fs.rm(scratch, { force: true }).catch(() => undefined)
    throw err
  }
}
