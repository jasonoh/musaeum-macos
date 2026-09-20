export type BookFormat = 'epub' | 'mobi' | 'azw3' | 'pdf'

/**
 * The on-disk extension for each format, with its dot. The one declaration of
 * "what is a book file" the on-ramps share: the drag-drop gate and the native
 * picker's filter are both derived from this map, so they cannot disagree.
 *
 * The `Record<BookFormat, …>` is load-bearing — a sixth format without an
 * extension is a `npm run typecheck` failure, which is the only place a new
 * union member can be caught before it leaves an on-ramp behind. Five other
 * declarations of this fact still exist in the main process
 * (`services/importer.ts`, `services/book-files.ts`, `ipc/migration.ts`,
 * `services/file-watcher.ts`, `sidecar/pipeline/migrate.py`); they are
 * deliberately not folded in here, and each one still has to be updated by
 * hand when a format is added.
 */
export const BOOK_FILE_EXTENSIONS: Record<BookFormat, string> = {
  epub: '.epub',
  mobi: '.mobi',
  azw3: '.azw3',
  pdf: '.pdf'
}

/**
 * Whether a filename is one the import pipeline accepts. Case-insensitive
 * because Finder hands over the on-disk name, and a suffix match rather than a
 * `split('.')` so a name with no extension at all ("epub") is rejected.
 *
 * Exported (rather than left in the drop handler) because a file either on-ramp
 * rejects never reaches main — a missing extension there is a silent no-op, not
 * a failed import — and PDF became first-class in Phase 1.5 with the drop gate
 * left behind on the old three formats.
 */
export function isBookFile(name: string): boolean {
  const lower = name.toLowerCase()
  return Object.values(BOOK_FILE_EXTENSIONS).some((ext) => lower.endsWith(ext))
}

/**
 * `dialog.showOpenDialog`'s filter for the book-file picker, derived from the
 * same map. Electron takes extensions without their dots, so the derivation
 * lives here beside the list rather than at the call site: a hand-written
 * filter array in the handler would be the sixth declaration of this fact, and
 * the one a new format is most likely to miss.
 */
export function bookFileFilter(): { name: string; extensions: string[] } {
  return {
    name: 'Book files',
    extensions: Object.values(BOOK_FILE_EXTENSIONS).map((ext) => ext.replace(/^\./, ''))
  }
}

export type ReadStatus = 'unread' | 'reading' | 'read'

/**
 * Where the reader left off. `position` is opaque to Musaeum — an EPUB CFI,
 * whatever mobi.js yields for KF8, a page number for PDF — because three
 * engines have to share one schema and none of them agree on a format.
 * `percent` is the portable fallback: when a position no longer resolves,
 * the reader seeks to the fraction instead.
 */
export interface ReadingState {
  position: string | null
  percent: number
  updatedAt: string
}

/**
 * What the reader reports as the user moves through a book. `final` marks a
 * session boundary (reader closed, app quitting) — see reading-state.ts for
 * what that costs. Shared because the renderer sends it and the main process
 * consumes it.
 */
export interface ProgressReport {
  bookId: string
  position: string | null
  percent: number
  final: boolean
}

/**
 * What a manual Refresh or Rebuild reports back. Both return the same *shape*
 * because either can become the other: `library-sync.refreshLibrary` walks and
 * rebuilds when the catalog is missing, so a caller cannot tell which ran
 * without being told. `cancelled` is true only for a rebuild the user stopped,
 * and in that case nothing was written.
 */
export interface CatalogSyncOutcome {
  books: number
  cancelled: boolean
}

/**
 * The refresh-or-rebuild the status bar is showing. One shape for the whole
 * lifecycle — a live counter, then a settled line — because the job outlives
 * both the Settings dialog that triggers it and the sidebar row that used to
 * carry its progress. `outcome` settles in place rather than the line simply
 * disappearing, which is the failure `docs/invariants/refresh-feedback.md`
 * records for a job that stops reporting at the moment it matters.
 */
export interface CatalogSyncState {
  kind: 'refresh' | 'rebuild'
  completed: number
  /** Null until the walk's first progress event reports the folder count. */
  total: number | null
  outcome: 'running' | 'done' | 'cancelled' | 'failed'
  /** Books the settled run produced; null while running, and when cancelled. */
  books: number | null
}

export interface Book {
  id: string
  title: string
  sortTitle: string | null
  author: string | null
  authorSort: string | null
  publisher: string | null
  publishedDate: string | null
  language: string | null
  description: string | null
  isbn10: string | null
  isbn13: string | null
  goodreadsId: string | null
  openlibraryId: string | null
  seriesName: string | null
  seriesIndex: number | null
  seriesTotal: number | null
  coverThumbPath: string | null
  coverFullPath: string | null
  formats: BookFormat[]
  tags: string[]
  rating: number | null
  dateAdded: string | null
  lastModified: string | null
  fileSizeBytes: number | null
  readStatus: ReadStatus
  nasPath: string | null
  readingState: ReadingState | null
}

/** Reference compare, except arrays, which are compared by value. */
export function sameBookValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  return false
}

/**
 * The format the in-app reader should open, in preference order. PDF is
 * deliberately absent until C2 ships — a PDF-only book falls through to the
 * system opener, where Preview handles it well.
 *
 * Exported because the order is not the reader's alone: a re-fetch asks the
 * sidecar to read a book's embedded metadata, and only an EPUB (or a PDF)
 * carries any as far as that extractor is concerned — so the file a card
 * would open and the file a re-fetch reads have to be the same choice.
 */
export const READABLE_FORMATS: BookFormat[] = ['epub', 'azw3', 'mobi']

export function readableFormat(book: Book): BookFormat | null {
  return READABLE_FORMATS.find((f) => book.formats.includes(f)) ?? null
}

/**
 * Format preference order: what the reader would open first, PDF last — it
 * has no in-app reader and is never converted, so it is the odd one out rather
 * than anyone's first choice.
 */
const FORMAT_ORDER: BookFormat[] = [...READABLE_FORMATS, 'pdf']

/**
 * The book's formats in preference order. One ordering rule for every label,
 * so a card's chip and its tooltip cannot disagree — the database's own array
 * order is not stable (`["epub","mobi"]` and `["mobi","epub"]` are both
 * common), which is why nothing may read `formats[0]` directly. Formats the
 * order doesn't know are kept, after the known ones.
 */
export function orderedFormats(book: Book): BookFormat[] {
  const known = FORMAT_ORDER.filter((f) => book.formats.includes(f))
  return [...known, ...book.formats.filter((f) => !known.includes(f))]
}

/**
 * The format a card names: the one the reader would open. A PDF-only book has
 * no *readable* format and still gets labelled — "PDF" is the one worth seeing
 * from across the grid (never converted, no in-app reader).
 */
export function primaryFormat(book: Book): BookFormat | null {
  return orderedFormats(book)[0] ?? null
}

export type SortField = 'title' | 'author' | 'series' | 'date_added' | 'rating' | 'read_status'

export interface BookSort {
  field: SortField
  direction: 'asc' | 'desc'
}

/** Human labels for every field/direction pair the sort UI can produce. */
const SORT_LABELS: Record<SortField, { asc: string; desc: string }> = {
  title: { asc: 'Title A–Z', desc: 'Title Z–A' },
  author: { asc: 'Author A–Z', desc: 'Author Z–A' },
  series: { asc: 'Series', desc: 'Series (reversed)' },
  date_added: { asc: 'Oldest First', desc: 'Recently Added' },
  rating: { asc: 'Lowest Rated', desc: 'Highest Rated' },
  read_status: { asc: 'Read Status', desc: 'Read Status (reversed)' }
}

export function sortLabel(sort: BookSort): string {
  return SORT_LABELS[sort.field][sort.direction]
}

/**
 * Guard for a sort that came from outside the type system — a restored
 * preference from a build whose fields differed would otherwise reach
 * `db.SORT_SQL`, which has no expression for it.
 */
export function isBookSort(value: unknown): value is BookSort {
  if (typeof value !== 'object' || value === null) return false
  const { field, direction } = value as { field?: unknown; direction?: unknown }
  return (
    typeof field === 'string' &&
    Object.prototype.hasOwnProperty.call(SORT_LABELS, field) &&
    (direction === 'asc' || direction === 'desc')
  )
}

/**
 * The direction a field sorts on first click: alphabetical fields read best
 * ascending, while dates and ratings are most useful highest-first.
 */
export function defaultSortDirection(field: SortField): 'asc' | 'desc' {
  return field === 'date_added' || field === 'rating' ? 'desc' : 'asc'
}

export interface BookFilters {
  authors?: string[]
  series?: string[]
  tags?: string[]
  formats?: BookFormat[]
  readStatus?: ReadStatus[]
  minRating?: number
  sort?: BookSort
}

/** Facet values with counts, for the filter sidebar. */
export interface LibraryFacets {
  authors: { value: string; count: number }[]
  series: { value: string; count: number }[]
  tags: { value: string; count: number }[]
  formats: { value: BookFormat; count: number }[]
  readStatus: { value: ReadStatus; count: number }[]
}

export type ImportStep =
  | 'received'
  | 'extracting'
  | 'duplicate_check'
  | 'awaiting_dedup_decision'
  | 'copying'
  | 'hydrating'
  | 'cover'
  | 'done'
  | 'skipped'
  | 'error'

export type DuplicateMatchType = 'isbn' | 'title_author'
export type DuplicateAction = 'skip' | 'add_new' | 'add_format'

export interface DuplicateContext {
  existingBookId: string
  existingTitle: string
  existingAuthor: string | null
  matchType: DuplicateMatchType
}

export interface DuplicateDecision {
  action: DuplicateAction
}

export interface ImportProgress {
  jobId: string
  fileName: string
  bookId: string | null
  step: ImportStep
  /** Set when step === 'error' */
  error?: string
  /** Set when step === 'awaiting_dedup_decision' */
  duplicate?: DuplicateContext
}

export interface ImportResult {
  jobId: string
  fileName: string
  success: boolean
  bookId?: string
  error?: string
  skipped?: boolean
  action?: DuplicateAction
}

/** Format "The Expanse #1" — drops trailing .0 on whole-number indices. */
export function seriesDisplay(name: string, index: number | null): string {
  if (index == null) return name
  // JS number formatting already drops the trailing .0 (String(1.0) === '1')
  return `${name} #${index}`
}

/**
 * Sort keys. Sorting reads `sort_title`/`author_sort` and falls back to the
 * display value, so a book that reaches the library without them sorts under
 * the wrong letter ("Seth Dickinson" under S). Only Calibre migration and the
 * occasional EPUB supply them, so every other write path derives them here.
 */

/** "The Great Gatsby" → "Great Gatsby, The" */
export function sortableTitle(title: string): string {
  const m = title.match(/^(The|A|An)\s+(.+)$/i)
  return m ? `${m[2]}, ${m[1]}` : title
}

/** Name particles that belong to the surname: "Ursula K. Le Guin" → "Le Guin, Ursula K." */
const NAME_PARTICLES = new Set([
  'af',
  'bin',
  'da',
  'de',
  'del',
  'della',
  'der',
  'di',
  'do',
  'dos',
  'du',
  'la',
  'le',
  'san',
  'st',
  'st.',
  'ten',
  'ter',
  'van',
  'von',
  'zu'
])

/** Generational suffixes, kept with the surname so "King Jr." still sorts under K. */
const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'i', 'ii', 'iii', 'iv', 'v'])

/** "Seth Dickinson" → "Dickinson, Seth" */
export function sortableAuthor(name: string | null | undefined): string | null {
  if (!name) return null
  const clean = name.trim().replace(/\s+/g, ' ')
  // Already inverted, or a multi-author string we'd only mangle by reordering
  if (!clean || clean.includes(',') || clean.includes('&') || / and /i.test(clean)) {
    return clean || null
  }

  const parts = clean.split(' ')
  const suffix =
    parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase())
      ? parts.pop()!
      : null
  if (parts.length < 2) return clean

  let firstOfLast = parts.length - 1
  while (firstOfLast > 1 && NAME_PARTICLES.has(parts[firstOfLast - 1].toLowerCase())) {
    firstOfLast--
  }
  const last = parts.slice(firstOfLast).join(' ')
  const rest = parts.slice(0, firstOfLast).join(' ')
  return `${last}${suffix ? ` ${suffix}` : ''}, ${rest}`
}
