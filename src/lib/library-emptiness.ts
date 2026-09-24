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
 *
 * The fourth case, added 2026-09-24 (`2026-09-20-library-onramps-and-maintenance-design.md`,
 * its *Open* section): an empty library whose storage cannot take a book. The
 * first-run block is **a promise that this library can receive books** — drop
 * them anywhere, or pick them — and with no root configured, or a folder that
 * has gone missing, every one of those affordances is refused by the write gate
 * (`nas-manager.ts`'s `assertOnline`). So the promise is not made: the pane
 * renders nothing and the banner directly above it carries both the sentence and
 * the recovery. That is also why the test is `storageConnected` — the same
 * question the six write-gating components ask, `state === 'connected'` — rather
 * than a comparison against copy: `src/lib/storage-copy-scan.test.ts` fails the
 * build if a renderer restates any sentence the composer in main owns.
 */
export type LibraryViewState =
  'loading' | 'empty-library' | 'no-matches' | 'library-unavailable' | 'books'

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
  /**
   * Whether the library can accept a write right now — `status.state === 'connected'`,
   * the same fact the write-gating components read. Required rather than
   * optional so a caller that adds a second view cannot forget it and inherit
   * the old unconditional promise.
   */
  storageConnected: boolean
}): LibraryViewState {
  // A reload keeps the previous result set on screen (`load` replaces `books`
  // only when the answer arrives), so a non-empty result always wins — the
  // alternative is the whole grid blanking on every keystroke in the search box
  if (input.resultCount > 0) return 'books'
  // Nothing to show *yet*, as opposed to nothing to show. Without this the
  // first-run state flashes on every cold start, for as long as the first load
  // takes — which on a cold NAS is seconds
  if (input.loading) return 'loading'
  // A query or a filter that matched nothing is a miss whatever the storage is
  // doing: the cache answers both, and "clear the search" is advice that needs
  // no write. Checked before the storage branch on purpose
  if (input.query.trim() || filterCount(input.filters) > 0) return 'no-matches'
  // Positive evidence only. An unreported status is not a working library, and
  // this pane may not make its promise on a guess — the same reason the loading
  // branch above renders nothing rather than the first-run copy
  if (!input.storageConnected) return 'library-unavailable'
  return 'empty-library'
}
