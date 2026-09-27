import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type {
  Book,
  BookFilters,
  BookFormat,
  BookSort,
  LibraryFacets,
  ReadingState,
  ReadStatus
} from '@shared/book.types'
import { sortableAuthor, sortableTitle } from '@shared/book.types'
import type { ConflictCandidate, MetadataConflict } from '@shared/metadata.types'
import type { ShelfScope, ShelfSummary, ShelvesFile } from '@shared/shelf.types'
import { isManualShelf } from '@shared/shelf.types'
import migration001 from '../schema/migrations/001_initial.sql?raw'
import migration002 from '../schema/migrations/002_sort_keys.sql?raw'
import migration003 from '../schema/migrations/003_reading_state.sql?raw'
import migration004 from '../schema/migrations/004_device_file_identity.sql?raw'
import migration005 from '../schema/migrations/005_device_history_outlives_book.sql?raw'
import migration006 from '../schema/migrations/006_shelves.sql?raw'

const MIGRATIONS: string[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006
]

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    const path = join(app.getPath('userData'), 'musaeum.db')
    db = new Database(path)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    registerFunctions(db)
    runMigrations(db)
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

/**
 * Expose the shared sort-key derivations to SQL so a backfill migration and
 * the TypeScript write paths can't drift apart. Registered before migrations
 * run, since 002 calls them.
 */
function registerFunctions(d: Database.Database): void {
  d.function('musaeum_sort_title', { deterministic: true }, (title: unknown) =>
    typeof title === 'string' ? sortableTitle(title) : null
  )
  d.function('musaeum_author_sort', { deterministic: true }, (author: unknown) =>
    typeof author === 'string' ? sortableAuthor(author) : null
  )
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
    { value: string } | undefined
  return row?.value ?? null
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

/**
 * Clear a config key. Distinct from storing '' — every reader treats a missing
 * key as "fall back to auto-detection", and an empty string would defeat that.
 */
export function deleteConfig(key: string): void {
  getDb().prepare('DELETE FROM app_config WHERE key = ?').run(key)
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
  reading_position: string | null
  reading_percent: number | null
  reading_updated_at: string | null
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
    readStatus: (r.read_status ?? READ_STATUS_FALLBACK) as ReadStatus,
    nasPath: r.nas_path,
    // `updated_at` is the presence marker: a row with no timestamp has never
    // been opened, and reporting `percent: 0` would render as 0% progress
    // rather than as "not started"
    readingState: r.reading_updated_at
      ? {
          position: r.reading_position,
          percent: r.reading_percent ?? 0,
          updatedAt: r.reading_updated_at
        }
      : null
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

/**
 * What a row with no `read_status` counts as.
 *
 * The column is `DEFAULT 'unread'` but **not** `NOT NULL`
 * (`electron/main/schema/migrations/001_initial.sql:26`), so the fallback has to be
 * stated wherever the column is read raw, and three places do: `rowToBook`, the
 * facets query and the filter below. It lives here once because a fourth spelling of
 * `'unread'` is how the sidebar's count and its own filter drift apart — a book
 * counted as unread but not returned by `readStatus=unread` is a phone showing a
 * number that leads nowhere. No row carries a NULL status today (measured
 * 2026-09-22); this is what keeps that harmless if one ever does.
 */
const READ_STATUS_FALLBACK = 'unread'

/** What a set of filters becomes: one condition per filter, and the bound parameters. */
interface BookWhere {
  conditions: string[]
  params: unknown[]
}

/**
 * **The one place a `BookFilters` becomes SQL.**
 *
 * Extracted from `getBooks`'s own body rather than written beside it, because
 * the paginated read (D7) has to slice *this* query: a second WHERE builder for
 * the wire would be a second home for the filter rules, which is the drift the
 * sort-key invariant (4) exists to prevent, one level down. Every caller —
 * `getBooks`, the count, the paged reads, the FTS join — goes through here.
 *
 * Conditions are unqualified by default, because the plain query has one table
 * and that is the SQL `getBooks` has always issued. A caller that joins
 * `books_fts` passes `books.` because the FTS table carries `title`/`author`
 * columns of its own and SQLite rejects those references as ambiguous.
 */
function bookWhere(filters?: BookFilters, tablePrefix = ''): BookWhere {
  const conditions: string[] = []
  const params: unknown[] = []
  const col = (name: string): string => `${tablePrefix}${name}`

  if (filters?.authors?.length) {
    conditions.push(`${col('author')} IN (${filters.authors.map(() => '?').join(',')})`)
    params.push(...filters.authors)
  }
  if (filters?.series?.length) {
    conditions.push(`${col('series_name')} IN (${filters.series.map(() => '?').join(',')})`)
    params.push(...filters.series)
  }
  if (filters?.readStatus?.length) {
    // Through READ_STATUS_FALLBACK — the same fallback `rowToBook` applies — so the
    // facets' count and this filter cannot disagree about the same book
    const values = filters.readStatus.map(() => '?').join(',')
    conditions.push(`COALESCE(${col('read_status')}, '${READ_STATUS_FALLBACK}') IN (${values})`)
    params.push(...filters.readStatus)
  }
  if (filters?.minRating != null) {
    conditions.push(`${col('rating')} >= ?`)
    params.push(filters.minRating)
  }
  if (filters?.tags?.length) {
    // Book matches if it has ANY of the selected tags
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(books.tags) WHERE json_each.value IN (${filters.tags.map(() => '?').join(',')}))`
    )
    params.push(...filters.tags)
  }
  if (filters?.formats?.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(books.formats) WHERE json_each.value IN (${filters.formats.map(() => '?').join(',')}))`
    )
    params.push(...filters.formats)
  }
  if (filters?.shelfId) {
    // A shelf is a scope (bookshelves D7), but it enters SQL here like any
    // filter, so the list, the page, the count and the facets cannot disagree.
    // `books.id` rather than `col('id')`: every caller's FROM names `books`,
    // and inside the subquery an unqualified `id` would be a guess.
    conditions.push(
      'EXISTS (SELECT 1 FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?)'
    )
    params.push(filters.shelfId)
  }

  return { conditions, params }
}

/** `WHERE a AND b`, or '' when nothing is filtered. */
function whereClause(where: BookWhere): string {
  return where.conditions.length ? `WHERE ${where.conditions.join(' AND ')}` : ''
}

export function getBooks(filters?: BookFilters): Book[] {
  return selectBooks(filters, null).map(rowToBook)
}

export interface BookPage {
  books: Book[]
  /** Every row the same filters match, independent of the page taken. */
  total: number
}

/** One page's worth of `SELECT`s: a limit and a skip, both required. */
export interface BookPageRequest {
  limit: number
  offset: number
}

/**
 * The `SELECT` both list paths share — with the paging appended, or without it.
 *
 * `page` omitted is *exactly* the statement `getBooks` has always run: no LIMIT,
 * no OFFSET, no extra bind. That is AC12's whole content, and it is why paging
 * is opt-in by argument rather than by a default — a default that reached the
 * app's own call sites would change the library view, not the wire.
 */
function selectBooks(filters: BookFilters | undefined, page: BookPageRequest | null): BookRow[] {
  const where = bookWhere(filters)
  const order = orderClause(filters?.sort, '', filters?.shelfId)
  const paging = page ? ' LIMIT ? OFFSET ?' : ''
  // WHERE, then ORDER BY, then LIMIT/OFFSET — the order the placeholders appear in
  const params = [...where.params, ...order.params, ...(page ? [page.limit, page.offset] : [])]
  return getDb()
    .prepare(`SELECT * FROM books ${whereClause(where)} ORDER BY ${order.sql}${paging}`)
    .all(...params) as BookRow[]
}

/**
 * One page of `getBooks`'s query, and the total it was sliced from (D7).
 *
 * The order is `getBooks`'s own — the same `orderClause`, so the `id` tiebreak
 * that keeps a tied sort stable is the same one a page walk relies on. A second
 * `ORDER BY` here is what would let a book appear on two pages or on none.
 */
export function getBooksPage(filters: BookFilters | undefined, page: BookPageRequest): BookPage {
  return {
    books: selectBooks(filters, page).map(rowToBook),
    total: countBooks(filters)
  }
}

/**
 * How many rows these filters match, from the same WHERE body `getBooks` runs.
 *
 * Deliberately not a hand-written `COUNT(*)`: a count that carried its own
 * filter rules would answer a different question from the list it is reported
 * beside, and that divergence is invisible until a client pages off the end.
 * `healthPayload`'s book count is this call with no filters, which is what
 * retires the whole-library load 1a answered that route with (~115 ms at 7,100
 * books, on the phone's connect check).
 */
export function countBooks(filters?: BookFilters): number {
  const where = bookWhere(filters)
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM books ${whereClause(where)}`)
    .get(...where.params) as { n: number }
  return row.n
}

/** An ORDER BY body and what it binds — only `shelf_added` binds anything. */
interface OrderBy {
  sql: string
  params: unknown[]
}

/**
 * ORDER BY body for a sort; falls back to title ascending on an unknown field.
 *
 * A tied primary sort (same author, same rating, same read_status, ...)
 * otherwise leaves the remaining order to SQLite, which is free to answer from
 * a different physical row order call to call (e.g. after a row is rewritten),
 * so a virtualized view can visibly reshuffle equal rows on reload with nothing
 * about the *data* having changed. `id` is appended as a final, always-present
 * tiebreak so ties always resolve the same way.
 *
 * The tiebreak is deliberately pinned ascending rather than following `dir`:
 * direction is applied to every key *of the requested sort* because those keys
 * carry meaning (descending 'series' means "show the series in reverse", not
 * just "flip the index"), but `id` carries no such meaning — it is an arbitrary
 * uniqueness key, not a field the user chose to sort by. Pinning it also means
 * flipping a sort's direction and flipping it back returns tied rows to the
 * order they started in.
 *
 * `shelf_added` is the one sort that is not a column (bookshelves D8): it is
 * the open shelf's `added_at`, a correlated read bound to `shelfId`. Without a
 * shelf it has nothing to order by and takes the unknown-field fallback to
 * title, like any field `SORT_SQL` has no expression for — never a throw.
 */
function orderClause(
  sort: BookSort = { field: 'title', direction: 'asc' },
  tablePrefix = '',
  shelfId?: string
): OrderBy {
  const dir = sort.direction === 'desc' ? 'DESC' : 'ASC'
  const tiebreak = `${tablePrefix}id ASC`
  if (sort.field === 'shelf_added' && shelfId) {
    return {
      sql: `(SELECT shelf_books.added_at FROM shelf_books WHERE shelf_books.book_id = books.id AND shelf_books.shelf_id = ?) ${dir}, ${tiebreak}`,
      params: [shelfId]
    }
  }
  // Direction applies to every key, so descending 'series' fully reverses
  // series order rather than only flipping the index within each series
  const keys = (SORT_SQL[sort.field] ?? SORT_SQL.title)(tablePrefix).map((expr) => `${expr} ${dir}`)
  keys.push(tiebreak)
  return { sql: keys.join(', '), params: [] }
}

export function getBook(id: string): Book | null {
  const row = getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined
  return row ? rowToBook(row) : null
}

/**
 * Whether the cache holds this book, without building the row.
 *
 * For the callers that are asking about *existence* rather than about a book:
 * `field-overrides.ts` sweeps its map of books that are gone, where reading
 * every column of every entry would be work thrown away.
 */
export function bookExists(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM books WHERE id = ?').get(id) !== undefined
}

/**
 * FTS search. Results are ordered by the given sort so the list-view headers
 * and the toolbar dropdown stay live during a search; with no sort they fall
 * back to FTS relevance rank. A `scope` searches inside one shelf (bookshelves
 * D7); the facet filters are still not applied here — widening that is not
 * this feature.
 */
export function searchBooks(query: string, sort?: BookSort, scope?: ShelfScope): Book[] {
  const filters = scope?.shelfId ? { shelfId: scope.shelfId } : undefined
  return searchRows(query, sort, filters, null).map(rowToBook)
}

/**
 * One page of `searchBooks`'s results, and the total it was sliced from.
 *
 * **The same FTS path, not a second one.** The match expression, the join and
 * the terms' quoting all come from the one statement below, so the ids a phone
 * sees for `q=` are the ids the app's own search returns (AC11); the filters are
 * the same WHERE body `getBooks` uses, qualified for the join, so a search may
 * also be narrowed by the library's own filters.
 *
 * With no `sort` the order stays FTS `rank` — relevance is what a search is for
 * — with the book's `id` appended as a tiebreak. `searchBooks` and this
 * function share the one statement below, so the app's own unpaged search gets
 * that tiebreak too: a refinement of ties only (SQLite previously left them to
 * happenstance), and the thing that makes a *page* walk over equal ranks unable
 * to serve a book twice or not at all — the failure `orderClause` documents for
 * the list.
 */
export function searchBooksPage(
  query: string,
  page: BookPageRequest,
  filters?: BookFilters
): BookPage {
  return {
    books: searchRows(query, filters?.sort, filters, page).map(rowToBook),
    total: countSearchRows(query, filters)
  }
}

/** The terms of a query, quoted and prefix-matched — the one parser both paths use. */
function searchMatch(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' ')
}

function searchRows(
  query: string,
  sort: BookSort | undefined,
  filters: BookFilters | undefined,
  page: BookPageRequest | null
): BookRow[] {
  const match = searchMatch(query)
  // No terms is not an empty search — it is the library, exactly as the app's
  // own `searchBooks` answers it (a query of only quotes or spaces).
  if (!match) return selectBooks(filters ? { ...filters, sort } : sort ? { sort } : undefined, page)

  const where = bookWhere(filters, 'books.')
  const paging = page ? ' LIMIT ? OFFSET ?' : ''
  // `rank` carries no uniqueness key of its own, so a paged rank walk needs the
  // same `id` tiebreak a sorted one has — appended only when there is no sort,
  // because reverse-engineering `orderClause` would be the second ordering rule
  // this file refuses to grow (invariant 4).
  const order: OrderBy = sort
    ? orderClause(sort, 'books.', filters?.shelfId)
    : { sql: 'rank, books.id ASC', params: [] }
  const params = [
    match,
    ...where.params,
    ...order.params,
    ...(page ? [page.limit, page.offset] : [])
  ]

  return getDb()
    .prepare(
      `SELECT books.* FROM books_fts
       JOIN books ON books.rowid = books_fts.rowid
       WHERE books_fts MATCH ?${where.conditions.length ? ` AND ${where.conditions.join(' AND ')}` : ''}
       ORDER BY ${order.sql}${paging}`
    )
    .all(...params) as BookRow[]
}

/** How many rows the same search matches, over the same join and WHERE body. */
function countSearchRows(query: string, filters?: BookFilters): number {
  const match = searchMatch(query)
  if (!match) return countBooks(filters)

  const where = bookWhere(filters, 'books.')
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM books_fts
       JOIN books ON books.rowid = books_fts.rowid
       WHERE books_fts MATCH ?${where.conditions.length ? ` AND ${where.conditions.join(' AND ')}` : ''}`
    )
    .get(match, ...where.params) as { n: number }
  return row.n
}

export function insertBook(book: Book): void {
  getDb()
    .prepare(
      `INSERT INTO books (
        id, title, sort_title, author, author_sort, publisher, published_date,
        language, description, isbn_10, isbn_13, goodreads_id, openlibrary_id,
        series_name, series_index, series_total, cover_thumb_path, cover_full_path,
        formats, tags, rating, date_added, last_modified, file_size_bytes,
        read_status, nas_path, reading_position, reading_percent, reading_updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      book.nasPath,
      book.readingState?.position ?? null,
      book.readingState?.percent ?? null,
      book.readingState?.updatedAt ?? null
    )
}

export function updateBook(id: string, updates: Partial<Book>): void {
  // Invariant 4 at the write primitive: a patch that moves a title or author
  // moves its sort key too, unless it names one itself (the editor's custom
  // sort title). Without this a resolved title conflict kept its old key for
  // good — catalog adoption only fills a *missing* key, never a stale one.
  const patch: Partial<Book> = { ...updates }
  if (typeof patch.title === 'string' && patch.sortTitle === undefined) {
    patch.sortTitle = sortableTitle(patch.title)
  }
  if (patch.author !== undefined && patch.authorSort === undefined) {
    patch.authorSort = sortableAuthor(patch.author)
  }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
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

/**
 * Reading position has its own writer rather than going through `updateBook`:
 * it is a nested value the generic column map can't flatten, and `updateBook`
 * bumps `last_modified` on every call — turning a page is not a metadata edit.
 */
export function setReadingState(id: string, state: ReadingState): void {
  getDb()
    .prepare(
      `UPDATE books SET reading_position = ?, reading_percent = ?, reading_updated_at = ?
       WHERE id = ?`
    )
    .run(state.position, state.percent, state.updatedAt, id)
}

/**
 * Move a book's reading-state clock without touching where it is.
 *
 * `read_status` is one of the two fields `services/reading-state.ts` treats as
 * reading state, and this column is that state's clock — the thing
 * `library-sync.ts` compares to decide whether this machine's copy is newer
 * than the catalog's. Every *automatic* writer already moves it (a progress
 * save records the position and the status together), but a change the user
 * made in the detail panel did not, so it was a decision adoption could not
 * see: measured on the real library, a book un-marked from Reading held Unread
 * in `metadata.json` and Reading in `catalog.json`, and the next launch's
 * adoption took the catalog's.
 *
 * A status-only change therefore yields a state with a null position.
 * `rowToBook` reads a non-null `reading_updated_at` as "this machine has
 * reading state for this book", and every consumer of the position treats
 * "no position" as "open at the beginning" — the reader's `initial.position`
 * guard skips `goTo` and paints the first page, which is exactly what the
 * null state it replaces did.
 */
export function touchReadingState(id: string, updatedAt: string): void {
  getDb().prepare('UPDATE books SET reading_updated_at = ? WHERE id = ?').run(updatedAt, id)
}

/**
 * Remove a book's cache row. Dependent rows go with it — a conflict or a
 * shelf membership is about the book and means nothing without it — with
 * one deliberate exception: `device_history` outlives the book, because it is
 * a log of what this machine sent rather than a child of the row (migration
 * 005; `replaceAllBooks` honours the same rule).
 */
export function deleteBook(id: string): void {
  const d = getDb()
  d.transaction(() => {
    d.prepare('DELETE FROM shelf_books WHERE book_id = ?').run(id)
    d.prepare('DELETE FROM metadata_conflicts WHERE book_id = ?').run(id)
    d.prepare('DELETE FROM books WHERE id = ?').run(id)
  })()
}

export function findByIsbn13(isbn13: string): Book | null {
  const row = getDb().prepare('SELECT * FROM books WHERE isbn_13 = ?').get(isbn13) as
    BookRow | undefined
  return row ? rowToBook(row) : null
}

/**
 * Another book holding this ISBN-13, or null. Excludes the asking book, which
 * is not a duplicate of itself — the caller is the one that just settled the
 * ISBN it is asking about.
 *
 * `idx_books_isbn13` covers this, so it is a seek on one value.
 */
export function findOtherByIsbn13(bookId: string, isbn13: string): Book | null {
  const row = getDb()
    .prepare('SELECT * FROM books WHERE isbn_13 = ? AND id <> ? LIMIT 1')
    .get(isbn13, bookId) as BookRow | undefined
  return row ? rowToBook(row) : null
}

/** Loose title+author duplicate check: normalized case/punctuation equality. */
export function findByTitleAuthor(title: string, author: string | null): Book | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  const rows = getDb().prepare("SELECT * FROM books WHERE title <> '' ").all() as BookRow[]
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
 * disabled for the swap. Conflict and shelf-membership rows for vanished
 * books are pruned; FTS follows via the existing triggers.
 */
export function replaceAllBooks(books: Book[]): void {
  const d = getDb()
  d.pragma('foreign_keys = OFF')
  try {
    d.transaction(() => {
      d.prepare('DELETE FROM books').run()
      for (const b of books) insertBook(b)
      d.prepare('DELETE FROM metadata_conflicts WHERE book_id NOT IN (SELECT id FROM books)').run()
      d.prepare('DELETE FROM shelf_books WHERE book_id NOT IN (SELECT id FROM books)').run()
    })()
  } finally {
    d.pragma('foreign_keys = ON')
  }
}

/**
 * The filter sidebar's counts. With a `scope` they count one shelf's books
 * (bookshelves D7) — through `bookWhere`, the one place a filter becomes SQL, so
 * a count and the list it sits beside cannot disagree.
 */
export function getFacets(scope?: ShelfScope): LibraryFacets {
  const d = getDb()
  const where = bookWhere(scope?.shelfId ? { shelfId: scope.shelfId } : undefined)
  const and = where.conditions.map((c) => ` AND ${c}`).join('')
  const p = where.params
  const authors = d
    .prepare(
      `SELECT author AS value, COUNT(*) AS count FROM books WHERE author IS NOT NULL${and} GROUP BY author ORDER BY count DESC, author`
    )
    .all(...p) as { value: string; count: number }[]
  const series = d
    .prepare(
      `SELECT series_name AS value, COUNT(*) AS count FROM books WHERE series_name IS NOT NULL${and} GROUP BY series_name ORDER BY count DESC, series_name`
    )
    .all(...p) as { value: string; count: number }[]
  const tags = d
    .prepare(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM books, json_each(books.tags)
       WHERE books.tags IS NOT NULL${and} GROUP BY json_each.value ORDER BY count DESC, value`
    )
    .all(...p) as { value: string; count: number }[]
  const formats = d
    .prepare(
      `SELECT json_each.value AS value, COUNT(*) AS count FROM books, json_each(books.formats)
       WHERE books.formats IS NOT NULL${and} GROUP BY json_each.value ORDER BY count DESC, value`
    )
    .all(...p) as { value: BookFormat; count: number }[]
  const readStatus = d
    .prepare(
      // The fallback is READ_STATUS_FALLBACK, `rowToBook`'s own rule in SQL, so a row
      // the app shows as unread is counted in that bucket; the tiebreak is what makes
      // "ordered by count descending" true of this list too, as the document says of
      // all five
      `SELECT COALESCE(read_status, '${READ_STATUS_FALLBACK}') AS value, COUNT(*) AS count FROM books
       ${whereClause(where)}
       GROUP BY COALESCE(read_status, '${READ_STATUS_FALLBACK}') ORDER BY count DESC, value`
    )
    .all(...p) as { value: ReadStatus; count: number }[]
  return { authors, series, tags, formats, readStatus }
}

// --- Shelves: a cache of shelves.json (services/shelves.ts owns every write) ---

/**
 * Replace the shelf cache with a file's view, in one transaction (bookshelves
 * D2, D4). Called by every shelf write with the file it just wrote, and by
 * adoption with the file it just read — one path, so the two cannot drift.
 *
 * - Only manual shelves: a kind this build does not know stays in the file and
 *   out of the cache (D1).
 * - A member whose book this cache does not hold is left out and **kept in the
 *   file** — the catalog may simply be behind (a book imported on another Mac).
 * - A repeated shelf id or member in a hand-edited file is ignored, first
 *   occurrence wins, rather than failing the whole adoption on a primary key.
 */
export function replaceAllShelves(file: ShelvesFile): void {
  const d = getDb()
  const insertShelf = d.prepare(
    "INSERT INTO shelves (id, name, kind, created_at, updated_at) VALUES (?, ?, 'manual', ?, ?)"
  )
  const insertMember = d.prepare(
    `INSERT OR IGNORE INTO shelf_books (shelf_id, book_id, added_at)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM books WHERE id = ?)`
  )
  d.transaction(() => {
    d.prepare('DELETE FROM shelf_books').run()
    d.prepare('DELETE FROM shelves').run()
    const seen = new Set<string>()
    for (const shelf of file.shelves) {
      if (!isManualShelf(shelf) || seen.has(shelf.id)) continue
      seen.add(shelf.id)
      insertShelf.run(shelf.id, shelf.name, shelf.created_at, shelf.updated_at)
      for (const member of shelf.books) {
        insertMember.run(shelf.id, member.id, member.added_at, member.id)
      }
    }
  })()
}

interface ShelfSummaryRow {
  id: string
  name: string
  count: number
}

function toShelfSummary(r: ShelfSummaryRow): ShelfSummary {
  return { id: r.id, name: r.name, kind: 'manual', count: r.count }
}

/**
 * Every shelf, alphabetically and case-insensitively, then by id (D6). The count
 * is the cache's membership, which holds only books the library has —
 * `replaceAllShelves`, `deleteBook` and `replaceAllBooks` all keep it that way.
 */
export function listShelves(): ShelfSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.name, COUNT(sb.book_id) AS count
         FROM shelves s LEFT JOIN shelf_books sb ON sb.shelf_id = s.id
        GROUP BY s.id
        ORDER BY s.name COLLATE NOCASE, s.id`
    )
    .all() as ShelfSummaryRow[]
  return rows.map(toShelfSummary)
}

/** The shelves one book is on, in `listShelves`'s order. */
export function shelvesForBook(bookId: string): ShelfSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.name,
              (SELECT COUNT(*) FROM shelf_books c WHERE c.shelf_id = s.id) AS count
         FROM shelves s JOIN shelf_books m ON m.shelf_id = s.id AND m.book_id = ?
        ORDER BY s.name COLLATE NOCASE, s.id`
    )
    .all(bookId) as ShelfSummaryRow[]
  return rows.map(toShelfSummary)
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

export function insertConflict(
  bookId: string,
  field: string,
  candidates: ConflictCandidate[]
): void {
  getDb()
    .prepare('INSERT INTO metadata_conflicts (book_id, field, candidates) VALUES (?, ?, ?)')
    .run(bookId, field, JSON.stringify(candidates))
}

export function getConflict(
  id: number
): { bookId: string; field: string; candidates: ConflictCandidate[] } | null {
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

// --- Device file identity cache ---

/**
 * What one device file said about itself, and the file version it said it
 * about. `size`/`mtimeMs` are the cache key's other half: a file replaced under
 * the same name has different ones, so its stale facts are re-read rather than
 * believed.
 */
export interface DeviceFileIdentityRecord {
  path: string
  size: number
  mtimeMs: number
  title: string | null
  author: string | null
  uuid: string | null
  cdetype: string | null
}

interface DeviceFileIdentityRow {
  path: string
  size: number
  mtime_ms: number
  title: string | null
  author: string | null
  uuid: string | null
  cdetype: string | null
}

/**
 * Cached identities for these paths, at whatever version they were read. The
 * caller compares the stored size/mtime against the file's own before using
 * one — this answers "have we ever read it", not "is this still true".
 */
export function getDeviceFileIdentities(paths: string[]): Map<string, DeviceFileIdentityRecord> {
  const found = new Map<string, DeviceFileIdentityRecord>()
  if (!paths.length) return found
  const d = getDb()
  const statement = d.prepare(
    'SELECT path, size, mtime_ms, title, author, uuid, cdetype FROM device_file_identity WHERE path = ?'
  )
  d.transaction(() => {
    for (const path of paths) {
      const row = statement.get(path) as DeviceFileIdentityRow | undefined
      if (!row) continue
      found.set(row.path, {
        path: row.path,
        size: row.size,
        mtimeMs: row.mtime_ms,
        title: row.title,
        author: row.author,
        uuid: row.uuid,
        cdetype: row.cdetype
      })
    }
  })()
  return found
}

/** Record what a batch of files said about themselves — one write per batch. */
export function putDeviceFileIdentities(records: DeviceFileIdentityRecord[]): void {
  if (!records.length) return
  const d = getDb()
  const statement = d.prepare(
    `INSERT INTO device_file_identity (path, size, mtime_ms, title, author, uuid, cdetype, read_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size, mtime_ms = excluded.mtime_ms, title = excluded.title,
       author = excluded.author, uuid = excluded.uuid, cdetype = excluded.cdetype,
       read_at = excluded.read_at`
  )
  const readAt = new Date().toISOString()
  d.transaction(() => {
    for (const r of records) {
      statement.run(r.path, r.size, r.mtimeMs, r.title, r.author, r.uuid, r.cdetype, readAt)
    }
  })()
}

/**
 * Drop cached facts for files that are no longer on the device. A row is keyed
 * by absolute path, so a file renamed on the device would otherwise keep its
 * entry for good — the table has to stay a report about what is there.
 */
export function deleteDeviceFileIdentities(paths: string[]): void {
  if (!paths.length) return
  const d = getDb()
  const statement = d.prepare('DELETE FROM device_file_identity WHERE path = ?')
  d.transaction(() => {
    for (const path of paths) statement.run(path)
  })()
}

/** Cached paths under `prefix` — how a device's stale rows are found. */
export function deviceFileIdentityPathsUnder(prefix: string): string[] {
  const rows = getDb()
    .prepare('SELECT path FROM device_file_identity WHERE path LIKE ? ESCAPE ?')
    .all(`${prefix.replace(/[%_\\]/g, '\\$&')}%`, '\\') as { path: string }[]
  return rows.map((r) => r.path)
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
