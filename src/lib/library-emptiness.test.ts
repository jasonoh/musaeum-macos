import { describe, expect, it } from 'vitest'
import type { BookFilters } from '@shared/book.types'
import { filterCount, libraryViewState } from './library-emptiness'

const NONE: BookFilters = {}

function view(over: Partial<Parameters<typeof libraryViewState>[0]> = {}) {
  return libraryViewState({ loading: false, query: '', filters: NONE, resultCount: 0, ...over })
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
