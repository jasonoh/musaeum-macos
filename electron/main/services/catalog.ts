import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { extname, join } from 'path'
import type { Book, BookFormat, ReadStatus } from '@shared/book.types'

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
    return { state: 'ok', file: parsed }
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
  date_added?: string | null
  last_modified?: string | null
}

const VALID_FORMATS = new Set(['epub', 'mobi', 'azw3', 'pdf'])
const READ_STATUSES = new Set(['unread', 'reading', 'read'])

export async function metadataJsonToBook(
  json: MetadataJson,
  dirName: string,
  bookDir: string
): Promise<Book> {
  // metadata.json doesn't carry file sizes — sum the book files on disk
  let fileSizeBytes: number | null = null
  try {
    let total = 0
    for (const f of await fs.readdir(bookDir)) {
      if (!VALID_FORMATS.has(extname(f).toLowerCase().slice(1))) continue
      total += (await fs.stat(join(bookDir, f))).size
    }
    fileSizeBytes = total > 0 ? total : null
  } catch {
    // unreadable dir — size stays unknown
  }

  return {
    id: json.id || dirName,
    title: json.title,
    sortTitle: json.sort_title ?? null,
    author: json.authors?.[0]?.name ?? null,
    authorSort: json.authors?.[0]?.sort ?? null,
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
    readStatus: (READ_STATUSES.has(json.read_status ?? '') ? json.read_status : 'unread') as ReadStatus,
    nasPath: join('books', dirName)
  }
}

export interface RebuildProgress {
  completed: number
  total: number
}

/**
 * Recovery path: walk every books/<uuid>/metadata.json and rewrite the catalog.
 * Slow over SMB (minutes at library scale) — only run on user request or
 * when no catalog exists.
 */
export async function rebuildFromBookDirs(
  root: string,
  onProgress?: (p: RebuildProgress) => void
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
  const books = [...byId.values()]
  await replaceCatalog(root, books)
  return books
}
