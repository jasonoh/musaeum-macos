import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { Book, BookFormat, ReadingState, ReadStatus } from '@shared/book.types'
import { sortableAuthor, sortableTitle } from '@shared/book.types'
import { computeFileSizeBytes } from './book-files'

export const CATALOG_FILENAME = 'catalog.json'
export const CATALOG_VERSION = 1

/**
 * catalog.json at the library root: a derived, regenerable cache of every
 * book's metadata.json, read on launch so a machine never has to walk
 * thousands of book folders over SMB. The per-book metadata.json files
 * remain canonical — losing or corrupting the catalog is never data loss.
 */
export interface CatalogFile {
  version: number
  generated_at: string
  books: Book[]
}

export function catalogPath(root: string): string {
  return join(root, CATALOG_FILENAME)
}

export type CatalogReadState =
  | { state: 'ok'; file: CatalogFile }
  | { state: 'missing' } // ENOENT — no catalog has ever been written
  | { state: 'invalid' } // exists but unparsable / wrong version / wrong shape

/**
 * Fill in sort keys a catalog entry is missing. Adoption replaces the local
 * cache wholesale, so without this a catalog written before sort keys were
 * derived would undo the backfill on every connect — and the book would go
 * back to sorting under its first name. The derived values reach catalog.json
 * on the next write, since writes come from the adopted cache.
 */
function withSortKeys(book: Book): Book {
  if (book.sortTitle && (book.authorSort || !book.author)) return book
  return {
    ...book,
    sortTitle: book.sortTitle ?? sortableTitle(book.title),
    authorSort: book.authorSort ?? sortableAuthor(book.author)
  }
}

/**
 * Reading state as it arrives from a file — every field is `unknown` because
 * both files carrying it (metadata.json, catalog.json) are written by us but
 * read from a NAS any machine can touch, and either may have been hand-edited
 * or written by a different version.
 */
type UntrustedReadingState =
  { position?: unknown; percent?: unknown; updatedAt?: unknown } | null | undefined

/**
 * The one validator for reading state off disk, used by both read paths: a
 * percent outside 0–1 would drive a progress bar off its track, and a
 * non-string position would be handed to the engine as a seek target.
 */
function validateReadingState(raw: UntrustedReadingState): ReadingState | null {
  if (!raw || typeof raw !== 'object') return null
  const percent =
    typeof raw.percent === 'number' && Number.isFinite(raw.percent)
      ? Math.min(1, Math.max(0, raw.percent))
      : 0
  return {
    position: typeof raw.position === 'string' ? raw.position : null,
    percent,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  }
}

/**
 * Normalize one catalog entry on read. catalog.json is read on every launch,
 * so it needs the same guards the cold path (`metadataJsonToBook`) applies to
 * metadata.json: it lives on a share any machine can write, and an
 * out-of-range percent or non-string position reaching the reader is the same
 * bug from either file. Entries with no reading state — nearly all of them —
 * skip the allocation.
 */
function fromCatalogEntry(book: Book): Book {
  const normalized = withSortKeys(book)
  const readingState = validateReadingState(normalized.readingState)
  if (readingState === null && normalized.readingState == null) return normalized
  return { ...normalized, readingState }
}

export async function readCatalogDetailed(root: string): Promise<CatalogReadState> {
  let raw: string
  try {
    raw = await fs.readFile(catalogPath(root), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    throw err // transient I/O (SMB blip, permissions) must NOT look like "no catalog"
  }
  try {
    const parsed = JSON.parse(raw) as CatalogFile
    if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.books)) {
      return { state: 'invalid' }
    }
    return { state: 'ok', file: { ...parsed, books: parsed.books.map(fromCatalogEntry) } }
  } catch {
    return { state: 'invalid' }
  }
}

export async function readCatalog(root: string): Promise<CatalogFile | null> {
  const result = await readCatalogDetailed(root)
  return result.state === 'ok' ? result.file : null
}

/** Atomic write: .part then rename, so a crash never leaves a torn catalog. */
export async function writeCatalog(root: string, books: Book[]): Promise<void> {
  const file: CatalogFile = {
    version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    books
  }
  const target = catalogPath(root)
  await fs.writeFile(`${target}.part`, JSON.stringify(file), 'utf8')
  await fs.rename(`${target}.part`, target)
}

export function mergeBooks(current: Book[], updates: Book[]): Book[] {
  const byId = new Map(current.map((b) => [b.id, b]))
  for (const b of updates) byId.set(b.id, b)
  return [...byId.values()]
}

/** Typed field copy — keeps `mergeBookFields` free of casts. */
function copyField<K extends keyof Book>(target: Book, source: Book, key: K): void {
  target[key] = source[key]
}

/**
 * Merge only `fields` from each update onto the catalog's existing entry,
 * instead of replacing it (`mergeBooks`). A whole-record upsert is right after
 * a deliberate edit, where this machine's copy *is* the newest; it is wrong
 * for a background push like reading position, where the rest of this
 * machine's snapshot may be days stale and would silently overwrite a title,
 * tag or rating changed on another machine. A book the catalog does not hold
 * at all is inserted whole — there is nothing to preserve.
 */
export function mergeBookFields(
  current: Book[],
  updates: Book[],
  fields: readonly (keyof Book)[]
): Book[] {
  const byId = new Map(current.map((b) => [b.id, b]))
  for (const update of updates) {
    const existing = byId.get(update.id)
    if (!existing) {
      byId.set(update.id, update)
      continue
    }
    const merged = { ...existing }
    for (const field of fields) copyField(merged, update, field)
    byId.set(update.id, merged)
  }
  return [...byId.values()]
}

// All catalog mutations funnel through one promise chain — concurrent
// imports would otherwise interleave their read-modify-write cycles
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Upsert books into the catalog. When the catalog is missing or unreadable,
 * `fallback` supplies the base list (callers pass the local cache) so a
 * fresh catalog is complete rather than containing only the upserted books.
 */
export function upsertIntoCatalog(
  root: string,
  updates: Book[],
  fallback: () => Book[]
): Promise<void> {
  return enqueue(async () => {
    const current = (await readCatalog(root))?.books ?? fallback()
    await writeCatalog(root, mergeBooks(current, updates))
  })
}

/**
 * Like `upsertIntoCatalog`, but updates only `fields` on entries the catalog
 * already holds (see `mergeBookFields`). Same serialized read-modify-write.
 */
export function updateFieldsInCatalog(
  root: string,
  updates: Book[],
  fields: readonly (keyof Book)[],
  fallback: () => Book[]
): Promise<void> {
  return enqueue(async () => {
    const current = (await readCatalog(root))?.books ?? fallback()
    await writeCatalog(root, mergeBookFields(current, updates, fields))
  })
}

export function removeFromCatalog(
  root: string,
  bookId: string,
  fallback: () => Book[]
): Promise<void> {
  return enqueue(async () => {
    const current = (await readCatalog(root))?.books ?? fallback()
    await writeCatalog(
      root,
      current.filter((b) => b.id !== bookId)
    )
  })
}

/** Wholesale rewrite (bulk operations, rebuild). */
export function replaceCatalog(root: string, books: Book[]): Promise<void> {
  return enqueue(() => writeCatalog(root, books))
}

/** The canonical per-book metadata.json shape (writer: importer.writeMetadataJson). */
export interface MetadataJson {
  id: string
  title: string
  sort_title?: string | null
  authors?: { name: string; sort?: string | null }[]
  publisher?: string | null
  published_date?: string | null
  language?: string | null
  description?: string | null
  identifiers?: {
    isbn_10?: string | null
    isbn_13?: string | null
    goodreads?: string | null
    openlibrary?: string | null
  }
  series?: { name: string; index: number | null; total?: number | null } | null
  tags?: string[]
  cover?: { full?: string | null; thumb?: string | null } | null
  formats?: string[]
  rating?: number | null
  read_status?: string
  reading_state?: {
    position?: string | null
    percent?: number | null
    updated_at?: string | null
  } | null
  date_added?: string | null
  last_modified?: string | null
}

const VALID_FORMATS = new Set(['epub', 'mobi', 'azw3', 'pdf'])
const READ_STATUSES = new Set(['unread', 'reading', 'read'])

/** metadata.json's snake_case spelling, mapped onto the shared validator. */
function toReadingState(raw: MetadataJson['reading_state']): ReadingState | null {
  if (!raw || typeof raw !== 'object') return null
  return validateReadingState({
    position: raw.position,
    percent: raw.percent,
    updatedAt: raw.updated_at
  })
}

export async function metadataJsonToBook(
  json: MetadataJson,
  dirName: string,
  bookDir: string
): Promise<Book> {
  // metadata.json doesn't carry file sizes — sum the book files on disk
  const fileSizeBytes = await computeFileSizeBytes(bookDir)

  return {
    id: json.id || dirName,
    title: json.title,
    // Sort keys are derived when the file doesn't carry them, so a book
    // written by an older version still sorts under its surname/first word
    sortTitle: json.sort_title ?? (json.title ? sortableTitle(json.title) : null),
    author: json.authors?.[0]?.name ?? null,
    authorSort: json.authors?.[0]?.sort ?? sortableAuthor(json.authors?.[0]?.name),
    publisher: json.publisher ?? null,
    publishedDate: json.published_date ?? null,
    language: json.language ?? null,
    description: json.description ?? null,
    isbn10: json.identifiers?.isbn_10 ?? null,
    isbn13: json.identifiers?.isbn_13 ?? null,
    goodreadsId: json.identifiers?.goodreads ?? null,
    openlibraryId: json.identifiers?.openlibrary ?? null,
    seriesName: json.series?.name ?? null,
    seriesIndex: json.series?.index ?? null,
    seriesTotal: json.series?.total ?? null,
    coverThumbPath: json.cover?.thumb ?? null,
    coverFullPath: json.cover?.full ?? null,
    formats: (json.formats ?? []).filter((f): f is BookFormat => VALID_FORMATS.has(f)),
    tags: json.tags ?? [],
    rating: json.rating ?? null,
    dateAdded: json.date_added ?? null,
    lastModified: json.last_modified ?? null,
    fileSizeBytes,
    readStatus: (READ_STATUSES.has(json.read_status ?? '')
      ? json.read_status
      : 'unread') as ReadStatus,
    nasPath: join('books', dirName),
    readingState: toReadingState(json.reading_state)
  }
}

export interface RebuildProgress {
  completed: number
  total: number
}

/**
 * Recovery path: walk every books/<uuid>/metadata.json and rewrite the catalog.
 * Slow over SMB (minutes at library scale — measured at 1,281 s / 21.4 min for
 * 7,101 folders) — only run on user request or when no catalog exists.
 *
 * `isCancelled` is polled once per folder, which is where the walk's whole cost
 * is. On cancel this returns `[]` **without writing the catalog**: the single
 * write is `replaceCatalog` at the end, so abandoning costs nothing on disk.
 * That makes `[]` ambiguous between "cancelled" and "a library with no books",
 * and the caller must resolve it from its own flag — `isCancelled` is the
 * caller's own predicate, and `library-sync.rebuildCatalog` checks it with no
 * await in between. Anything that ever writes mid-walk must move this
 * guarantee (and that check) with it.
 */
export async function rebuildFromBookDirs(
  root: string,
  onProgress?: (p: RebuildProgress) => void,
  isCancelled?: () => boolean
): Promise<Book[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(join(root, 'books'), { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    entries = []
  }
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
  const byId = new Map<string, Book>()
  let completed = 0
  for (const dir of dirs) {
    if (isCancelled?.()) break
    const bookDir = join(root, 'books', dir.name)
    try {
      const raw = await fs.readFile(join(bookDir, 'metadata.json'), 'utf8')
      const json = JSON.parse(raw) as MetadataJson
      const book = await metadataJsonToBook(json, dir.name, bookDir)
      if (byId.has(book.id)) {
        console.error(
          `[catalog] rebuild: duplicate book id ${book.id} in ${dir.name} — keeping the later folder`
        )
      }
      byId.set(book.id, book)
    } catch (err) {
      console.error(`[catalog] rebuild: skipping ${dir.name}:`, err)
    }
    completed++
    onProgress?.({ completed, total: dirs.length })
  }
  // Re-read after the loop as well as inside it: a cancel that arrives while the
  // last folder is being read is still a cancel, and writing the catalog then
  // would be the one outcome the user asked not to have.
  if (isCancelled?.()) return []
  const books = [...byId.values()]
  await replaceCatalog(root, books)
  return books
}
