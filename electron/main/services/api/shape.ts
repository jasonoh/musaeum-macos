import type { Book, DuplicateContext, LibraryFacets, ReadStatus } from '@shared/book.types'
import { orderedFormats } from '@shared/book.types'

/**
 * The wire's shape, in one place (D10, invariant 8).
 *
 * **The consumer is outside this repo and outside this language**, so a response
 * is a contract rather than a projection of a table: a column rename here would
 * be a silent client break, and that is why every payload is assembled by an
 * explicit field list instead of by spreading a row. A field added to `Book`
 * does not appear on the wire until someone names it here *and* in
 * `docs/rest-api.md` — the pair that `shape.test.ts` holds together field for
 * field (AC19).
 *
 * **Pure, and deliberately so.** Nothing here reads the database, the
 * filesystem, the NAS or Electron: the values a payload needs that only the
 * route can read (the app's version, whether the share is mounted, the page
 * taken) arrive as arguments. That is what makes the list/detail/search path's
 * independence from the NAS visible in this file's imports rather than asserted
 * in a comment (AC16) — and it is why `healthPayload` lives here: 1a composed
 * that payload inside the socket module while D10 assigns response shaping to
 * this file, and one payload shaped in two places is how the document and the
 * wire drift apart.
 *
 * What deliberately **does not** cross: `nasPath` (the library's internal
 * layout), `sortTitle`/`authorSort` (derived sort keys — sorting is
 * server-side, on the same keys the app sorts by, so a second copy of them on
 * the wire could only disagree with it), the cover's filenames (the two sizes
 * are reported as booleans and fetched from their own route), and
 * `reading.position` — the Mac's CFI is a coordinate no other engine can use,
 * which is exactly why `percent` is the member the phone reads and writes (D5).
 */

/** The contract version the client checks (D12). Bump it on a payload change. */
export const API_VERSION = 1

/** A page is 100 rows unless asked otherwise, and never more than 500 (D7). */
export const DEFAULT_PAGE_LIMIT = 100
export const MAX_PAGE_LIMIT = 500

/**
 * The refusal bodies, in one place. A client switches on these words, so they
 * are as much a part of the contract as the payloads are — `docs/rest-api.md`
 * names every one of them with its status.
 */
export const API_ERRORS = {
  /** 401 — no credential, or the wrong one. */
  unauthorized: 'unauthorized',
  /** 400 — a request this route cannot make sense of. */
  badRequest: 'bad request',
  /** 404 — unknown book, unknown format, a format the book does not hold. */
  notFound: 'not found',
  /**
   * 413 — a body past the size this route will accept (D4 of the phone-upload
   * design). A *limit* rather than the malformed request `400` is defined as:
   * the body made perfect sense, there was simply too much of it, which is a
   * different sentence for a client and a different retry decision for a
   * person. The word is RFC 9110's own name for the status, lowercased like
   * every other value here.
   */
  tooLarge: 'content too large',
  /** 503 — too many byte transfers in flight; retry (D9). */
  busy: 'busy',
  /** 503 — the share is not mounted, so there are no bytes to serve. */
  offline: 'library offline',
  /** 416 — a range this file cannot satisfy. */
  rangeNotSatisfiable: 'range not satisfiable',
  /** 500 — a handler threw; the server keeps serving (invariant 12). */
  internal: 'internal'
} as const

export type ApiError = keyof typeof API_ERRORS

export function errorPayload(kind: ApiError): { error: string } {
  return { error: API_ERRORS[kind] }
}

/**
 * Every status the wire can carry, as values — the same union `WireReading`
 * declares, exhaustive by typecheck.
 *
 * It exists so a *request* can be checked against the contract the *response*
 * uses: `?readStatus=` accepts these and nothing else, from the same declaration
 * the payload reports, rather than from a second list beside it.
 */
export const READ_STATUSES: Record<ReadStatus, true> = {
  unread: true,
  reading: true,
  read: true
}

// ---------------------------------------------------------------------------
// Health — the connect check (D12)
// ---------------------------------------------------------------------------

export interface HealthPayload {
  apiVersion: number
  version: string
  /** Every book in the cache — the paginated total, not a whole-library load. */
  books: number
  library: 'online' | 'offline'
}

/**
 * The connect check. Its three values come from outside because three different
 * things know them (the contract, the app bundle, the NAS manager) and none of
 * them is this file; what this file owns is the payload's shape.
 *
 * **`books` is `countBooks()`'s answer, not `getBooks().length`.** 1a counted by
 * loading and mapping the whole cache — ~115 ms at this library's 7,100 books,
 * synchronously, on the route the phone uses as its connect check. The
 * replacement is the same count the library route reports as `total`, so the two
 * cannot disagree; a hand-written `COUNT(*)` beside it would be a second set of
 * filter rules, which is invariant 4's drift one level down.
 */
export function healthPayload(input: {
  version: string
  books: number
  online: boolean
}): HealthPayload {
  return {
    apiVersion: API_VERSION,
    version: input.version,
    books: input.books,
    library: input.online ? 'online' : 'offline'
  }
}

// ---------------------------------------------------------------------------
// A book
// ---------------------------------------------------------------------------

/**
 * The two covers a book may have, and the clock that versions them.
 *
 * The booleans say whether the row holds that size at all; a size it does not
 * hold answers 404 from the cover route, which is how the client decides
 * between a placeholder and a fetch. `version` is the row's `lastModified` —
 * the same clock the renderer's cover URL has carried since 2026-09-21, when a
 * constant URL turned out to be answered from Chromium's cache after the file
 * on disk had been replaced. The client appends it as a cache key; the route
 * ignores anything but `size`.
 */
export interface WireCover {
  thumb: boolean
  full: boolean
  version: string | null
}

/**
 * Where the book is, for the phone. `position` is absent by decision (D5): an
 * EPUB CFI is a coordinate no second engine can consume, and the portable
 * member is the fraction. `percent` and `updatedAt` are null when the machine
 * has never recorded reading state for the book — the same distinction
 * `rowToBook` keeps, because `percent: 0` would render as "started" where the
 * truth is "unopened".
 */
export interface WireReading {
  status: ReadStatus
  percent: number | null
  updatedAt: string | null
}

export interface WireBook {
  id: string
  title: string
  author: string | null
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
  tags: string[]
  rating: number | null
  dateAdded: string | null
  lastModified: string | null
  /** In preference order, so the first is the file the reader would open (invariant 3). */
  formats: string[]
  fileSizeBytes: number | null
  cover: WireCover
  reading: WireReading
  /**
   * The ids of the shelves this book is on — always present, `[]` when none
   * (bookshelves D10). Ids only: names come from `GET /api/shelves`, so a rename
   * changes no book payload.
   */
  shelves: string[]
}

/**
 * One book, shaped for the wire.
 *
 * `formats` goes through `orderedFormats()` rather than crossing as the row's
 * own array: the database's order is whatever the writing source left
 * (`["epub","mobi"]` and `["mobi","epub"]` are both common), so a client
 * labelling a book or picking a file would otherwise be reading `formats[0]` —
 * the one thing invariant 3 forbids on this side of the wire, and the reason the
 * order is settled before it leaves.
 *
 * `shelves` is **required** (S1 of the slice-5 plan): the member is always on
 * the payload, and a default would let a route forget to fill it — a book
 * silently reading as shelfless, with the field list still correct, which is the
 * one drift a shape cannot catch by its keys.
 */
export function bookPayload(book: Book, shelves: string[]): WireBook {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    publishedDate: book.publishedDate,
    language: book.language,
    description: book.description,
    isbn10: book.isbn10,
    isbn13: book.isbn13,
    goodreadsId: book.goodreadsId,
    openlibraryId: book.openlibraryId,
    seriesName: book.seriesName,
    seriesIndex: book.seriesIndex,
    seriesTotal: book.seriesTotal,
    tags: book.tags,
    rating: book.rating,
    dateAdded: book.dateAdded,
    lastModified: book.lastModified,
    formats: orderedFormats(book),
    fileSizeBytes: book.fileSizeBytes,
    cover: {
      thumb: book.coverThumbPath !== null,
      full: book.coverFullPath !== null,
      version: book.lastModified
    },
    reading: {
      status: book.readStatus,
      percent: book.readingState?.percent ?? null,
      updatedAt: book.readingState?.updatedAt ?? null
    },
    shelves
  }
}

// ---------------------------------------------------------------------------
// The reading report's answer — the one write this API has (D4, D5, D6)
// ---------------------------------------------------------------------------

export interface ReadingPayload {
  /**
   * Whether the report was applied. `false` is a *refusal*, not a failure: the
   * report's `at` was older than the row's own clock (D6), so the book did not
   * move backwards and nothing was written (AC21).
   */
  applied: boolean
  /** The book as it stands now — the same shape `GET /api/books/{id}` answers. */
  book: WireBook
}

/**
 * The answer to `PUT /api/books/{id}/reading`.
 *
 * It carries the **whole book** rather than a bare `{ applied }` because the
 * write and the read that follows it are one round trip: a client that has just
 * reported its position needs the state it should now resume from — including
 * the `read_status` a report may have advanced, and the `updatedAt` the next
 * report's `at` has to beat — and a second request to learn what it just wrote
 * would be a second thing that can fail. It is the same `bookPayload`, so a
 * detail response and a report response cannot describe one book two ways.
 *
 * A refusal answers the same payload with `applied: false` and the row
 * untouched, so a client's decoding is unconditional either way (D6: "the
 * current state").
 */
export function readingPayload(input: {
  applied: boolean
  book: Book
  shelves: string[]
}): ReadingPayload {
  return { applied: input.applied, book: bookPayload(input.book, input.shelves) }
}

// ---------------------------------------------------------------------------
// The upload's answer — the API's second write (D6)
// ---------------------------------------------------------------------------

/**
 * `POST /api/books`'s answer: the book that arrived, and the collision the
 * importer answered by policy rather than by asking.
 *
 * **`duplicate` is outside `book` deliberately.** It is a fact about the
 * *import* — what the pre-copy gate found — and not a property of the row, so
 * putting it inside `book` would give this one route a book shape no other
 * route's book has. Here every payload's `book` member is the same
 * `bookPayload`, which is what makes a client's decoding identical across them.
 *
 * **The book is pre-hydration, and that is the Mac's own contract rather than a
 * degradation for the phone** (D6's Consequence): `importer.importOne` inserts
 * the row and starts hydration without awaiting it, so the route reports the row
 * as it stands the moment the import returns — embedded metadata, `seriesName:
 * null`, and any title a fetch will settle arriving on the client's next list
 * fetch. The alternative (await the hydration) would hold a transfer slot for up
 * to five seconds so that a client's first look is the settled one.
 */
export interface ImportPayload {
  book: WireBook
  /** `null` when the import found no collision — the ordinary case. */
  duplicate: DuplicateContext | null
}

export function importPayload(input: {
  book: Book
  duplicate: DuplicateContext | null
  shelves: string[]
}): ImportPayload {
  return { book: bookPayload(input.book, input.shelves), duplicate: input.duplicate }
}

// ---------------------------------------------------------------------------
// The library, and its facets
// ---------------------------------------------------------------------------

export interface LibraryPayload {
  books: WireBook[]
  /** Every row the same query matches, independent of the page taken. */
  total: number
  limit: number
  offset: number
}

/**
 * One page of the library. `total` is what a client divides by `limit` to know
 * how much is left; `limit` and `offset` are echoed because a client that asked
 * for `limit=900` (clamped to 500) has to know what it actually got, and because
 * a page of results is only meaningful next to the window it came from.
 */
export function libraryPayload(page: {
  books: Book[]
  total: number
  limit: number
  offset: number
  /** Shelf ids per book id — one batched read over the page (bookshelves D10, S7). */
  shelves: Map<string, string[]>
}): LibraryPayload {
  return {
    // The arrow, not `page.books.map(bookPayload)`: `map`'s second argument is
    // the index, and the member's parameter is the shelf ids — passing the index
    // as shelves is the kind of thing a required parameter exists to make
    // impossible
    books: page.books.map((book) => bookPayload(book, page.shelves.get(book.id) ?? [])),
    total: page.total,
    limit: page.limit,
    offset: page.offset
  }
}

export interface FacetsPayload {
  authors: { value: string; count: number }[]
  series: { value: string; count: number }[]
  tags: { value: string; count: number }[]
  formats: { value: string; count: number }[]
  readStatus: { value: string; count: number }[]
}

/**
 * The filter sidebar's counts, which are the app's own `getFacets()` — computed
 * once, over the whole library, and deliberately not narrowed by the list
 * route's filters: a facet count that changed with the current filter would
 * tell the client nothing about what it could filter *to*.
 *
 * The five arrays are named here rather than passed through, so a sixth facet in
 * the service is a payload the document does not describe until someone adds it
 * to both (D10).
 */
export function facetsPayload(facets: LibraryFacets): FacetsPayload {
  return {
    authors: facets.authors,
    series: facets.series,
    tags: facets.tags,
    formats: facets.formats,
    readStatus: facets.readStatus
  }
}

// ---------------------------------------------------------------------------
// The shelves — the phone's browse (bookshelves D10)
// ---------------------------------------------------------------------------

/**
 * What a shelf row needs from the cache. Structurally `listShelves`'s shape
 * (`ShelfSummary`, `@shared/shelf.types`) plus the shelf file's own clock —
 * declared here rather than imported so this module's import list, which its own
 * case pins as the whole list, gains nothing for a type the compiler already
 * checks at the call site.
 */
export interface ShelfRowInput {
  id: string
  name: string
  kind: 'manual'
  count: number
  updatedAt: string
}

export interface WireShelf {
  id: string
  name: string
  kind: 'manual'
  count: number
  updatedAt: string
}

export interface ShelvesPayload {
  shelves: WireShelf[]
}

/**
 * Every shelf, as the sidebar sees them — `count` counts only members the
 * library holds (D6), and `updatedAt` is the shelf's own clock (`shelves.json`'s
 * `updated_at`, `services/db.ts`'s `listShelvesWithUpdatedAt`). Names come from
 * here, never from a book payload: a rename changes this response and no book.
 */
export function shelvesPayload(rows: ShelfRowInput[]): ShelvesPayload {
  return {
    shelves: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      count: row.count,
      updatedAt: row.updatedAt
    }))
  }
}
