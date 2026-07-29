import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  LibraryFacets,
  ReadStatus
} from '@shared/book.types'
import type { ConflictCandidate, MetadataConflict } from '@shared/metadata.types'
import migration001 from '../schema/migrations/001_initial.sql?raw'

const MIGRATIONS: string[] = [migration001]

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    const path = join(app.getPath('userData'), 'musaeum.db')
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

function runMigrations(d: Database.Database): void {
  const current = d.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v])
      d.pragma(`user_version = ${v + 1}`)
    })()
  }
}

// --- App config ---

export function getConfig(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

// --- Books ---

interface BookRow {
  id: string
  title: string
  sort_title: string | null
  author: string | null
  author_sort: string | null
  publisher: string | null
  published_date: string | null
  language: string | null
  description: string | null
  isbn_10: string | null
  isbn_13: string | null
  goodreads_id: string | null
  openlibrary_id: string | null
  series_name: string | null
  series_index: number | null
  series_total: number | null
  cover_thumb_path: string | null
  cover_full_path: string | null
  formats: string | null
  tags: string | null
  rating: number | null
  date_added: string | null
  last_modified: string | null
  file_size_bytes: number | null
  read_status: string | null
  nas_path: string | null
}

function rowToBook(r: BookRow): Book {
  return {
    id: r.id,
    title: r.title,
    sortTitle: r.sort_title,
    author: r.author,
    authorSort: r.author_sort,
    publisher: r.publisher,
    publishedDate: r.published_date,
    language: r.language,
    description: r.description,
    isbn10: r.isbn_10,
    isbn13: r.isbn_13,
    goodreadsId: r.goodreads_id,
    openlibraryId: r.openlibrary_id,
    seriesName: r.series_name,
    seriesIndex: r.series_index,
    seriesTotal: r.series_total,
    coverThumbPath: r.cover_thumb_path,
    coverFullPath: r.cover_full_path,
    formats: r.formats ? (JSON.parse(r.formats) as BookFormat[]) : [],
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    rating: r.rating,
    dateAdded: r.date_added,
    lastModified: r.last_modified,
    fileSizeBytes: r.file_size_bytes,
    readStatus: (r.read_status ?? 'unread') as ReadStatus,
    nasPath: r.nas_path
  }
}

const BOOK_COLUMN_MAP: Record<string, string> = {
  title: 'title',
  sortTitle: 'sort_title',
  author: 'author',
  authorSort: 'author_sort',
  publisher: 'publisher',
  publishedDate: 'published_date',
  language: 'language',
  description: 'description',
  isbn10: 'isbn_10',
  isbn13: 'isbn_13',
  goodreadsId: 'goodreads_id',
  openlibraryId: 'openlibrary_id',
  seriesName: 'series_name',
  seriesIndex: 'series_index',
  seriesTotal: 'series_total',
  coverThumbPath: 'cover_thumb_path',
  coverFullPath: 'cover_full_path',
  formats: 'formats',
  tags: 'tags',
  rating: 'rating',
  fileSizeBytes: 'file_size_bytes',
  readStatus: 'read_status',
  nasPath: 'nas_path'
}

/**
 * Sort expressions, parameterised by table prefix: the FTS search joins
 * `books_fts`, which also has `title`/`author` columns, so those references
 * must be qualified or SQLite rejects them as ambiguous.
 */
const SORT_SQL: Record<string, (t: string) => string[]> = {
  title: (t) => [`COALESCE(${t}sort_title, ${t}title) COLLATE NOCASE`],
  author: (t) => [`COALESCE(${t}author_sort, ${t}author) COLLATE NOCASE`],
  series: (t) => [`${t}series_name COLLATE NOCASE`, `${t}series_index`],
  date_added: (t) => [`${t}date_added`],
  rating: (t) => [`${t}rating`],
  read_status: (t) => [`${t}read_status`]
}

export function getBooks(filters?: BookFilters): Book[] {
  const where: string[] = []
  const params: unknown[] = []

  if (filters?.authors?.length) {
    where.push(`author IN (${filters.authors.map(() => '?').join(',')})`)
    params.push(...filters.authors)
  }
  if (filters?.series?.length) {
    where.push(`series_name IN (${filters.series.map(() => '?').join(',')})`)
    params.push(...filters.series)
  }
  if (filters?.readStatus?.length) {
    where.push(`read_status IN (${filters.readStatus.map(() => '?').join(',')})`)
    params.push(...filters.readStatus)
  }
  if (filters?.minRating != null) {
    where.push('rating >= ?')
    params.push(filters.minRating)
  }
  if (filters?.tags?.length) {
    // Book matches if it has ANY of the selected tags
    where.push(
      `EXISTS (SELECT 1 FROM json_each(books.tags) WHERE json_each.value IN (${filters.tags.map(() => '?').join(',')}))`
    )
    params.push(...filters.tags)
  }
  if (filters?.formats?.length) {
    where.push(
      `EXISTS (SELECT 1 FROM json_each(books.formats) WHERE json_each.value IN (${filters.formats.map(() => '?').join(',')}))`
    )
    params.push(...filters.formats)
  }

  const sql = `SELECT * FROM books ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderClause(filters?.sort)}`
  return (getDb().prepare(sql).all(...params) as BookRow[]).map(rowToBook)
}

/** ORDER BY body for a sort; falls back to title ascending on an unknown field. */
function orderClause(
  sort: BookSort = { field: 'title', direction: 'asc' },
  tablePrefix = ''
): string {
  const dir = sort.direction === 'desc' ? 'DESC' : 'ASC'
  // Direction applies to every key, so descending 'series' fully reverses
  // series order rather than only flipping the index within each series
  return (SORT_SQL[sort.field] ?? SORT_SQL.title)(tablePrefix)
    .map((expr) => `${expr} ${dir}`)
    .join(', ')
}

export function getBook(id: string): Book | null {
  const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined
  return row ? rowToBook(row) : null
}

/**
 * FTS search. Results are ordered by the given sort so the list-view headers
 * and the toolbar dropdown stay live during a search; with no sort they fall
 * back to FTS relevance rank.
 */
export function searchBooks(query: string, sort?: BookSort): Book[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter(Boolean)
  if (!terms.length) return getBooks(sort ? { sort } : undefined)
  // Quote each term and add prefix matching; AND semantics across terms
  const match = terms.map((t) => `"${t}"*`).join(' ')
  const rows = getDb()
    .prepare(
      `SELECT books.* FROM books_fts
       JOIN books ON books.rowid = books_fts.rowid
       WHERE books_fts MATCH ?
       ORDER BY ${sort ? orderClause(sort, 'books.') : 'rank'}`
    )
    .all(match) as BookRow[]
  return rows.map(rowToBook)
}

export function insertBook(book: Book): void {
  getDb()
    .prepare(
      `INSERT INTO books (
        id, title, sort_title, author, author_sort, publisher, published_date,
        language, description, isbn_10, isbn_13, goodreads_id, openlibrary_id,
        series_name, series_index, series_total, cover_thumb_path, cover_full_path,
        formats, tags, rating, date_added, last_modified, file_size_bytes,
        read_status, nas_path
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      book.id,
      book.title,
      book.sortTitle,
      book.author,
      book.authorSort,
      book.publisher,
      book.publishedDate,
      book.language,
      book.description,
      book.isbn10,
      book.isbn13,
      book.goodreadsId,
      book.openlibraryId,
      book.seriesName,
      book.seriesIndex,
      book.seriesTotal,
      book.coverThumbPath,
      book.coverFullPath,
      JSON.stringify(book.formats),
      JSON.stringify(book.tags),
      book.rating,
      book.dateAdded,
      book.lastModified,
      book.fileSizeBytes,
      book.readStatus,
      book.nasPath
    )
}

export function updateBook(id: string, updates: Partial<Book>): void {
  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(updates)) {
    const col = BOOK_COLUMN_MAP[key]
    if (!col) continue
    sets.push(`${col} = ?`)
    params.push(key === 'formats' || key === 'tags' ? JSON.stringify(value) : value)
  }
  if (!sets.length) return
  sets.push('last_modified = ?')
  params.push(new Date().toISOString())
  params.push(id)
  getDb()
    .prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params)
}

export function deleteBook(id: string): void {
  const d = getDb()
  d.transaction(() => {
    d.prepare('DELETE FROM book_collections WHERE book_id = ?').run(id)
    d.prepare('DELETE FROM metadata_conflicts WHERE book_id = ?').run(id)
    d.prepare('DELETE FROM books WHERE id = ?').run(id)
  })()
}

export function findByIsbn13(isbn13: string): Book | null {
  const row = getDb().prepare('SELECT * FROM books WHERE isbn_13 = ?').get(isbn13) as
    | BookRow
    | undefined
  return row ? rowToBook(row) : null
}

/** Loose title+author duplicate check: normalized case/punctuation equality. */
export function findByTitleAuthor(title: string, author: string | null): Book | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const rows = getDb()
    .prepare('SELECT * FROM books WHERE title <> \'\' ')
    .all() as BookRow[]
  const nt = norm(title)
  const na = author ? norm(author) : null
  for (const r of rows) {
    if (norm(r.title) !== nt) continue
    if (!na || !r.author || norm(r.author) === na) return rowToBook(r)
  }
  return null
}

/**
 * Replace the entire local cache with the catalog's view of the library.
 * device_history may reference books that no longer exist (they were sent
 * from this machine, then deleted elsewhere) — history is kept, so FKs are
 * disabled for the swap. Conflict/collection rows for vanished books are
 * pruned; FTS follows via the existing triggers.
 */
export function replaceAllBooks(books: Book[]): void {
  const d = getDb()
  d.pragma('foreign_keys = OFF')
  try {
    d.transaction(() => {
      d.prepare('DELETE FROM books').run()
      for (const b of books) insertBook(b)
      d.prepare(
        'DELETE FROM metadata_conflicts WHERE book_id NOT IN (SELECT id FROM books)'
      ).run()
      d.prepare(
        'DELETE FROM book_collections WHERE book_id NOT IN (SELECT id FROM books)'
      ).run()
    })()
  } finally {
    d.pragma('foreign_keys = ON')
  }
}

export function getFacets(): LibraryFacets {
  const d = getDb()
  const authors = d
    .prepare(
      `SELECT author AS value, COUNT(*) AS count FROM books WHERE author IS NOT NULL GROUP BY author ORDER BY count DESC, author`
    )
    .all() as { value: string; count: number }[]
  const series = d
    .prepare(
      `SELECT series_name AS value, COUNT(*) AS count FROM books WHERE series_name IS NOT NULL GROUP BY series_name ORDER BY count DESC, series_name`
    )
    .all() as { value: string; count: number }[]
  const tags = d
    .prepare(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM books, json_each(books.tags)
       WHERE books.tags IS NOT NULL GROUP BY json_each.value ORDER BY count DESC, value`
    )
    .all() as { value: string; count: number }[]
  const formats = d
    .prepare(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM books, json_each(books.formats)
       WHERE books.formats IS NOT NULL GROUP BY json_each.value ORDER BY count DESC`
    )
    .all() as { value: BookFormat; count: number }[]
  const readStatus = d
    .prepare(`SELECT read_status AS value, COUNT(*) AS count FROM books GROUP BY read_status`)
    .all() as { value: ReadStatus; count: number }[]
  return { authors, series, tags, formats, readStatus }
}

// --- Metadata conflicts ---

interface ConflictRow {
  id: number
  book_id: string
  field: string
  candidates: string
  resolved: number
  title: string
}

export function getConflictQueue(): MetadataConflict[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.book_id, c.field, c.candidates, c.resolved, b.title
       FROM metadata_conflicts c JOIN books b ON b.id = c.book_id
       WHERE c.resolved = 0 ORDER BY c.id`
    )
    .all() as ConflictRow[]
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    bookTitle: r.title,
    field: r.field,
    candidates: JSON.parse(r.candidates) as ConflictCandidate[],
    resolved: r.resolved === 1
  }))
}

export function getUnresolvedConflictCount(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM metadata_conflicts WHERE resolved = 0')
    .get() as { n: number }
  return row.n
}

export function insertConflict(bookId: string, field: string, candidates: ConflictCandidate[]): void {
  getDb()
    .prepare('INSERT INTO metadata_conflicts (book_id, field, candidates) VALUES (?, ?, ?)')
    .run(bookId, field, JSON.stringify(candidates))
}

export function getConflict(id: number): { bookId: string; field: string; candidates: ConflictCandidate[] } | null {
  const row = getDb()
    .prepare('SELECT book_id, field, candidates FROM metadata_conflicts WHERE id = ?')
    .get(id) as { book_id: string; field: string; candidates: string } | undefined
  if (!row) return null
  return {
    bookId: row.book_id,
    field: row.field,
    candidates: JSON.parse(row.candidates) as ConflictCandidate[]
  }
}

export function markConflictResolved(id: number, chosenSource: string): void {
  getDb()
    .prepare(
      'UPDATE metadata_conflicts SET resolved = 1, resolved_at = ?, chosen_source = ? WHERE id = ?'
    )
    .run(new Date().toISOString(), chosenSource, id)
}

/** Historical source preferences per field — used to bias future auto-resolution. */
export function getSourcePreferences(): Record<string, Record<string, number>> {
  const rows = getDb()
    .prepare(
      `SELECT field, chosen_source, COUNT(*) AS n FROM metadata_conflicts
       WHERE resolved = 1 AND chosen_source IS NOT NULL GROUP BY field, chosen_source`
    )
    .all() as { field: string; chosen_source: string; n: number }[]
  const prefs: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    prefs[r.field] ??= {}
    prefs[r.field][r.chosen_source] = r.n
  }
  return prefs
}

// --- Device history ---

export function logDeviceTransfer(
  bookId: string,
  deviceId: string,
  deviceName: string,
  format: string,
  error?: string
): void {
  getDb()
    .prepare(
      'INSERT INTO device_history (book_id, device_id, device_name, sent_at, format_sent, error) VALUES (?,?,?,?,?,?)'
    )
    .run(bookId, deviceId, deviceName, new Date().toISOString(), format, error ?? null)
}
