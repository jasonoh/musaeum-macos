import type { BookFilters, BookFormat, BookSort, ReadStatus } from '@shared/book.types'
import { BOOK_FILE_EXTENSIONS, defaultSortDirection, isBookSort } from '@shared/book.types'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, READ_STATUSES } from './shape'

/**
 * The library route's parameters, as a pure function of a URL (D2, AC9–AC12).
 *
 * Moved out of `api/rest.ts` (where these lines were reachable only through a
 * live socket) because D2's own test is "anything that can be a pure function
 * of inputs becomes one so the suite can decide it without a socket". Nothing
 * here reads a database, a file, the NAS or Electron: what a malformed
 * parameter *means* is a decision, and a decision belongs somewhere the suite
 * can make it — which is also what gives slice 1c's write the same discipline
 * for its body (`services/api/reading.ts`).
 *
 * **Every rule this applies is imported, not re-declared here:** which sort
 * fields and directions exist is `isBookSort` and `defaultSortDirection`
 * (`@shared/book.types`), which formats exist is `BOOK_FILE_EXTENSIONS`, which
 * read statuses exist is `READ_STATUSES` (the shaper's own values, so the
 * filter can only accept what the payload can report), and the page's bounds
 * are the shaper's `DEFAULT_PAGE_LIMIT`/`MAX_PAGE_LIMIT` — the same numbers the
 * response echoes back.
 *
 * What *is* decided here is what a malformed parameter means, and the answer is
 * a 400 rather than a silent default: a client that asked for `sort=athor` and
 * received title order would have no way to learn it had a typo. A `limit` above
 * the cap is the one value that is clamped rather than refused — asking for
 * everything is a request this surface can satisfy, at 500 rows.
 */

/** What `GET /api/library` was asked for. */
export interface LibraryQuery {
  /** The filters, including `sort` — the same object shape the app's own list takes. */
  filters: BookFilters
  /** The search term, or null for a plain list. */
  query: string | null
  limit: number
  offset: number
}

/** A request this surface cannot make sense of: answered 400, never defaulted. */
const INVALID_QUERY: { ok: false } = { ok: false }

export type ParsedLibraryQuery = { ok: true; query: LibraryQuery } | { ok: false }

export function parseLibraryQuery(url: URL): ParsedLibraryQuery {
  const params = url.searchParams

  const limit = intParam(params.get('limit'), DEFAULT_PAGE_LIMIT)
  if (limit === null) return INVALID_QUERY
  const offset = intParam(params.get('offset'), 0)
  if (offset === null) return INVALID_QUERY

  const filters: BookFilters = {}

  const authors = listParam(params, 'authors')
  if (authors) filters.authors = authors
  const series = listParam(params, 'series')
  if (series) filters.series = series
  const tags = listParam(params, 'tags')
  if (tags) filters.tags = tags

  const formats = listParam(params, 'formats')
  if (formats) {
    if (!formats.every((f) => f in BOOK_FILE_EXTENSIONS)) return INVALID_QUERY
    filters.formats = formats as BookFormat[]
  }

  const readStatus = listParam(params, 'readStatus')
  if (readStatus) {
    if (!readStatus.every((s) => s in READ_STATUSES)) return INVALID_QUERY
    filters.readStatus = readStatus as ReadStatus[]
  }

  const minRating = intParam(params.get('minRating'), null)
  if (minRating === null && params.get('minRating') !== null) return INVALID_QUERY
  if (minRating !== null) filters.minRating = minRating

  const shelf = parseShelfParam(params)
  if (!shelf.ok) return INVALID_QUERY
  if (shelf.shelfId) filters.shelfId = shelf.shelfId

  const query = params.get('q')?.trim() ?? ''
  const sort = parseSort(params, Boolean(filters.shelfId))
  if (!sort.ok) return INVALID_QUERY
  if (sort.sort) filters.sort = sort.sort
  else if (filters.shelfId && !query) {
    // With a shelf and neither a sort nor a search, the order is the Mac's own
    // default inside a shelf: Date Added to Shelf, newest first (D8, D10). A
    // search keeps FTS relevance, an ordering no field name can express.
    filters.sort = { field: 'shelf_added', direction: 'desc' }
  }

  return {
    ok: true,
    query: {
      filters,
      query: query || null,
      limit: Math.min(limit, MAX_PAGE_LIMIT),
      offset
    }
  }
}

/**
 * A whole, non-negative number, or `null` when the parameter is present and is
 * not one. `fallback` may itself be `null`, which is how an optional parameter
 * (one that is only 400 when it is *there* and wrong) is read.
 */
export function intParam(raw: string | null, fallback: number | null): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * A filter list: a repeated parameter and a comma-separated one are the same
 * thing, because a query string is written by hand in a smoke script and by a
 * URL builder in the client, and neither form should be the wrong one.
 */
export function listParam(params: URLSearchParams, name: string): string[] | null {
  const values = params
    .getAll(name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return values.length ? values : null
}

/**
 * The `shelf` parameter — one reader for both shelf-scoped routes (bookshelves
 * D10), so the list and its facets cannot scope two ways.
 *
 * Absent is `null`; **present and empty is a 400** (S4): a `shelf=` a client
 * meant to fill in is a request this surface cannot make sense of, and answering
 * it with the whole library is the wrap-around the `?limit=` case deliberately
 * keeps for numbers and this one does not.
 */
export type ParsedShelf = { ok: true; shelfId: string | null } | { ok: false }

export function parseShelfParam(params: URLSearchParams): ParsedShelf {
  const raw = params.get('shelf')
  if (raw === null) return { ok: true, shelfId: null }
  const shelfId = raw.trim()
  return shelfId ? { ok: true, shelfId } : { ok: false }
}

/**
 * `sort` / `dir`, through the guard that exists for a sort from outside the type
 * system.
 *
 * Three answers, and each means something different. `{ sort: null }` is "no sort
 * asked for" — which is *not* the same as `{ sort: { field: 'title', … } }`,
 * because a search without one keeps SQLite's FTS `rank`, an ordering no field
 * name can express. `{ ok: false }` is a 400. Anything else is the sort to run.
 *
 * `sort` alone defaults to `title`; `dir` alone is therefore a sort of titles,
 * and a direction that is neither `asc` nor `desc` is refused rather than
 * ignored. An absent `dir` takes the field's natural direction —
 * `defaultSortDirection`, the same rule the app's own sort control uses on a
 * first click — so a client asking for `sort=date_added` gets newest-first
 * rather than 1900-first.
 *
 * `hasShelf` is the caller's scope flag (bookshelves D10): `shelf_added` is a
 * real sort on the Mac (D8) and on the wire only next to a `shelf` to order by,
 * so without one it stays the unknown field it was before the type grew it — a
 * 400, rather than a silent fallback to title order.
 */
export function parseSort(
  params: URLSearchParams,
  hasShelf: boolean
): { ok: true; sort: BookSort | null } | { ok: false } {
  const field = params.get('sort')
  const direction = params.get('dir')
  if (field === null && direction === null) return { ok: true, sort: null }

  const candidate = { field: field ?? 'title', direction: direction ?? 'asc' }
  if (!isBookSort(candidate) || (candidate.field === 'shelf_added' && !hasShelf)) {
    return { ok: false }
  }

  return {
    ok: true,
    sort:
      direction === null
        ? { field: candidate.field, direction: defaultSortDirection(candidate.field) }
        : { field: candidate.field, direction: candidate.direction }
  }
}
