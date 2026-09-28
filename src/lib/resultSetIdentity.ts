import type { BookFilters, BookSort } from '@shared/book.types'

/**
 * The three pieces of state that decide which books `library.store`'s
 * `load()` fetches. Deliberately narrower than "the book list changed": a
 * metadata edit, a single-book delete, or a re-fetch of the same query all
 * replace `books` in place without any of these three changing, and the
 * library views' scroll position is meant to survive that untouched — only
 * a change in the *result set itself* should reset it.
 */
export interface ResultSetIdentity {
  query: string
  filters: BookFilters
  sort: BookSort
  /**
   * The open shelf, or null for the whole library (bookshelves D7). Part of the
   * identity, and unlike the filters it applies whether or not a query is
   * active — a shelf scopes the search too.
   */
  shelfId: string | null
}

/**
 * Stable key for a `ResultSetIdentity`: equal for two identities that would
 * fetch the same rows. Two normalizations matter, both because the store's
 * own write paths don't guarantee a canonical shape:
 *
 * - `query` is trimmed, since `load()` itself branches on `query.trim()` —
 *   `"dune"` and `"dune "` already address the same result set.
 * - filter arrays are sorted, since `toggleFilter` rebuilds them from a
 *   `Set` with no guaranteed iteration order — toggling two facets in either
 *   order must compare equal, and toggling the same one on and off must
 *   round-trip to the original key.
 *
 * One asymmetry is not a normalization but the store's real behaviour: while a
 * query is active the filters are **not part of the result set at all**.
 * `load()` calls `searchBooks(query, sort)` when a query is present and only
 * passes `filters` to `getBooks` when browsing
 * (`src/stores/library.store.ts:63-65`), so a facet click during a search
 * changes no rows and must not be read as a result-set change — otherwise the
 * reader's place is thrown away for a control that visibly does nothing.
 * Filters therefore enter the key only when they are actually applied. If that
 * branch in `load()` ever changes, this is the second place to change.
 *
 * The open shelf is not a normalization but the store's other real behaviour:
 * it scopes a search as well as a browse (`searchBooks(query, sort, scope)`),
 * so it stays in the key in both branches.
 */
export function resultSetKey(identity: ResultSetIdentity): string {
  const query = identity.query.trim()
  return JSON.stringify({
    query,
    filters: query ? null : normalizeFilters(identity.filters),
    sort: { field: identity.sort.field, direction: identity.sort.direction },
    shelfId: identity.shelfId
  })
}

/** True when two identities would fetch a different set of rows. */
export function resultSetChanged(a: ResultSetIdentity, b: ResultSetIdentity): boolean {
  return resultSetKey(a) !== resultSetKey(b)
}

/** Drops `undefined`/empty-array fields and sorts array values in place. */
function normalizeFilters(filters: BookFilters): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  const keys = Object.keys(filters) as (keyof BookFilters)[]
  for (const key of keys) {
    const value = filters[key]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      normalized[key] = [...value].sort()
    } else {
      normalized[key] = value
    }
  }
  return normalized
}
