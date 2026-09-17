import { describe, expect, it } from 'vitest'
import { resultSetChanged, resultSetKey, type ResultSetIdentity } from './resultSetIdentity'

const BASE: ResultSetIdentity = {
  query: 'dune',
  filters: { authors: ['Herbert'], tags: ['sci-fi', 'classic'] },
  sort: { field: 'title', direction: 'asc' }
}

function withIdentity(patch: Partial<ResultSetIdentity>): ResultSetIdentity {
  return { ...BASE, ...patch }
}

/** Browsing: no query, so the facet filters are what select the rows. */
const BROWSE = withIdentity({ query: '' })

describe('resultSetChanged', () => {
  it('is false for an identical input', () => {
    expect(resultSetChanged(BASE, withIdentity({}))).toBe(false)
  })

  it('is true when the query changes', () => {
    expect(resultSetChanged(BASE, withIdentity({ query: 'foundation' }))).toBe(true)
  })

  it('is false when only whitespace is added or removed from the query', () => {
    expect(resultSetChanged(BASE, withIdentity({ query: '  dune  ' }))).toBe(false)
    expect(resultSetChanged(withIdentity({ query: '' }), withIdentity({ query: '   ' }))).toBe(
      false
    )
  })

  it('is true when a facet filter is added while browsing', () => {
    // withIdentity (not a bare literal) so `formats` is checked as BookFormat[]
    const next = withIdentity({ query: '', filters: { ...BROWSE.filters, formats: ['epub'] } })
    expect(resultSetChanged(BROWSE, next)).toBe(true)
  })

  it('is true when a facet filter is removed while browsing', () => {
    const next = { ...BROWSE, filters: { authors: ['Herbert'] } }
    expect(resultSetChanged(BROWSE, next)).toBe(true)
  })

  it('is false when a facet changes during a search, which ignores filters', () => {
    // library.store.load() searches with searchBooks(query, sort) and passes
    // filters to getBooks only when browsing (library.store.ts:63-65), so a
    // facet click during a search cannot change the rows — and must not throw
    // away the reader's place for a control that visibly does nothing.
    const next = withIdentity({ filters: { ...BASE.filters, formats: ['epub'] } })
    expect(resultSetChanged(BASE, next)).toBe(false)
    expect(resultSetChanged(BASE, withIdentity({ filters: {} }))).toBe(false)
  })

  it('is false when a filter array is only reordered', () => {
    const next = { ...BROWSE, filters: { authors: ['Herbert'], tags: ['classic', 'sci-fi'] } }
    expect(resultSetChanged(BROWSE, next)).toBe(false)
  })

  it('is true when filters are cleared while browsing', () => {
    expect(resultSetChanged(BROWSE, { ...BROWSE, filters: {} })).toBe(true)
  })

  it('treats an empty-array filter the same as an absent one', () => {
    const withEmptyFormats = { ...BROWSE, filters: { ...BROWSE.filters, formats: [] } }
    expect(resultSetChanged(BROWSE, withEmptyFormats)).toBe(false)
  })

  it('is true when the sort field changes', () => {
    expect(
      resultSetChanged(BASE, withIdentity({ sort: { field: 'author', direction: 'asc' } }))
    ).toBe(true)
  })

  it('is true when the sort direction changes', () => {
    expect(
      resultSetChanged(BASE, withIdentity({ sort: { field: 'title', direction: 'desc' } }))
    ).toBe(true)
  })
})

describe('resultSetKey', () => {
  it('is order-independent for filter arrays', () => {
    const a = resultSetKey({ ...BROWSE, filters: { tags: ['a', 'b', 'c'] } })
    const b = resultSetKey({ ...BROWSE, filters: { tags: ['c', 'a', 'b'] } })
    expect(a).toBe(b)
  })

  it('ignores filters entirely while a query is active', () => {
    expect(resultSetKey(BASE)).toBe(resultSetKey(withIdentity({ filters: {} })))
  })
})
