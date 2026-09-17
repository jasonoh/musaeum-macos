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
 */
export function resultSetKey(identity: ResultSetIdentity): string {
  return JSON.stringify({
    query: identity.query.trim(),
    filters: normalizeFilters(identity.filters),
    sort: { field: identity.sort.field, direction: identity.sort.direction }
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
