import { describe, expect, it } from 'vitest'
import type { BookFilters } from '@shared/book.types'
import { filterCount, libraryViewState } from './library-emptiness'

const NONE: BookFilters = {}

function view(over: Partial<Parameters<typeof libraryViewState>[0]> = {}) {
  return libraryViewState({
    loading: false,
    query: '',
    filters: NONE,
    resultCount: 0,
    // Connected unless a case says otherwise: every case below is about what the
    // pane says about the *library*, and the storage half has its own cases
    storageConnected: true,
    shelfId: null,
    ...over
  })
}

/**
 * The state that decides whether a first-run user is offered the way to get
 * books in. Getting this wrong in either direction is visible: a false
 * "empty-library" offers Calibre migration to someone who mistyped a search, and
 * a false "no-matches" leaves a genuinely empty library with no on-ramp at all —
 * which is how it shipped.
 */
describe('libraryViewState', () => {
  it('calls a library with no query, no filters and no results empty', () => {
    // With nothing narrowing it, the result set *is* the library
    expect(view()).toBe('empty-library')
  })

  it('calls an empty result set with a query a miss, not an empty library', () => {
    expect(view({ query: 'dune' })).toBe('no-matches')
  })

  it('treats whitespace as no query', () => {
    expect(view({ query: '   ' })).toBe('empty-library')
  })

  it('calls an empty result set with a filter a miss, not an empty library', () => {
    expect(view({ filters: { formats: ['pdf'] } })).toBe('no-matches')
  })

  it('is a books view whenever there is something to show', () => {
    expect(view({ resultCount: 3 })).toBe('books')
    expect(view({ resultCount: 3, query: 'dune' })).toBe('books')
    expect(view({ resultCount: 1, filters: { readStatus: ['read'] } })).toBe('books')
  })

  it('shows nothing rather than the first-run state while the first load is in flight', () => {
    // The flash this prevents: a cold start on a NAS reports zero books for
    // seconds, and "Your library awaits" is a lie about a 7,000-book library
    expect(view({ loading: true })).toBe('loading')
  })

  it('keeps the previous results on screen while a reload is in flight', () => {
    // A keystroke in the search box must not blank the grid
    expect(view({ loading: true, resultCount: 12 })).toBe('books')
  })

  it('prefers the miss copy while loading only if something is filtering', () => {
    // No results, still loading, and a query: the spinner is the honest answer,
    // not "nothing matches" — the search has not answered yet
    expect(view({ loading: true, query: 'dune' })).toBe('loading')
  })
})

/**
 * The storage half, added 2026-09-24. The pane's first-run block is a promise
 * that a dropped or picked book will land, and only one storage state keeps it:
 * the on-ramps are refused by the write gate for *every* other one. Each case
 * below is paired with its opposite, because "renders nothing" is satisfied by
 * deleting the pane.
 */
describe('libraryViewState — the storage half', () => {
  it('offers the first-run pane only where the library can actually take a book', () => {
    expect(view({ storageConnected: true })).toBe('empty-library')
    expect(view({ storageConnected: false })).toBe('library-unavailable')
  })

  it('keeps a miss a miss whatever the storage is doing', () => {
    // The cache answers a search and a filter with no root at all — and
    // "clear the search" is advice that needs no write
    expect(view({ storageConnected: false, query: 'dune' })).toBe('no-matches')
    expect(view({ storageConnected: false, filters: { formats: ['pdf'] } })).toBe('no-matches')
  })

  it('keeps results on screen while the storage is away', () => {
    // Browsing the cache is the one thing that still works offline, so this
    // branch must not be reachable from a non-empty result set
    expect(view({ storageConnected: false, resultCount: 12 })).toBe('books')
  })

  it('prefers loading over unavailable while the first load is in flight', () => {
    // Both render nothing; the state is what the next reader reads
    expect(view({ storageConnected: false, loading: true })).toBe('loading')
  })
})

describe('an empty shelf (AC17)', () => {
  it('is its own state, not an empty library', () => {
    expect(view({ shelfId: 's1' })).toBe('empty-shelf')
  })

  it('loses to a query or a filter that matched nothing on it', () => {
    expect(view({ query: 'dune', shelfId: 's1' })).toBe('no-matches')
    expect(view({ filters: { tags: ['epic'] }, shelfId: 's1' })).toBe('no-matches')
  })

  it('renders nothing when the library cannot take a write (R5)', () => {
    // The shelf's own copy is a write instruction ("drag books here"), so it
    // takes the same gate the first-run pane takes — the banner above carries
    // the sentence and the recovery instead
    expect(view({ shelfId: 's1', storageConnected: false })).toBe('library-unavailable')
  })

  it('loses to books and to loading, like every other state', () => {
    expect(view({ shelfId: 's1', resultCount: 3 })).toBe('books')
    expect(view({ shelfId: 's1', loading: true })).toBe('loading')
  })

  it('leaves the library\u2019s own states alone', () => {
    expect(view({ shelfId: null })).toBe('empty-library')
  })
})

describe('filterCount', () => {
  it('counts nothing for an empty object or empty arrays', () => {
    expect(filterCount({})).toBe(0)
    expect(filterCount({ formats: [], tags: [] })).toBe(0)
  })

  it('counts every selected value across kinds', () => {
    expect(filterCount({ formats: ['pdf'], tags: ['sci-fi', 'owned'] })).toBe(3)
  })

  it('counts a minimum rating as one filter, and ignores sort', () => {
    expect(filterCount({ minRating: 4 })).toBe(1)
    expect(filterCount({ minRating: 0 })).toBe(1)
    expect(filterCount({ sort: { field: 'title', direction: 'asc' } })).toBe(0)
  })
})
