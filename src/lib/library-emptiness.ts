import type { BookFilters } from '@shared/book.types'

/**
 * What the library's main pane should show, as one decision both views share.
 *
 * The trap this exists to close: `books` in the store is the *result set*, not
 * the library (`library.store.ts` loads through `getBooks(filters)` or
 * `searchBooks(query)`), so "no books" has three different meanings and only one
 * of them is a first-run user with an empty library. Offering "Migrate from
 * Calibre…" to someone who mistyped a query is worse than offering nothing —
 * hence a named state rather than a length check at each call site.
 *
 * No total is needed: with no query and no filters, `books` *is* the library.
 */
export type LibraryViewState = 'loading' | 'empty-library' | 'no-matches' | 'books'

/**
 * Filters that are actually set. `sort` is not one — it orders the result rather
 * than narrowing it — and an empty array is the same as an absent key, which is
 * what `toggleFilter` leaves behind when the last value is unticked.
 */
export function filterCount(filters: BookFilters): number {
  let count = 0
  for (const value of [
    filters.authors,
    filters.series,
    filters.tags,
    filters.formats,
    filters.readStatus
  ]) {
    count += value?.length ?? 0
  }
  if (filters.minRating != null) count += 1
  return count
}

export function libraryViewState(input: {
  loading: boolean
  query: string
  filters: BookFilters
  resultCount: number
}): LibraryViewState {
  // A reload keeps the previous result set on screen (`load` replaces `books`
  // only when the answer arrives), so a non-empty result always wins — the
  // alternative is the whole grid blanking on every keystroke in the search box
  if (input.resultCount > 0) return 'books'
  // Nothing to show *yet*, as opposed to nothing to show. Without this the
  // first-run state flashes on every cold start, for as long as the first load
  // takes — which on a cold NAS is seconds
  if (input.loading) return 'loading'
  if (input.query.trim() || filterCount(input.filters) > 0) return 'no-matches'
  return 'empty-library'
}
