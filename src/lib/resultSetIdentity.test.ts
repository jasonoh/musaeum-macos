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

  it('is true when a facet filter is added', () => {
    const next = withIdentity({ filters: { ...BASE.filters, formats: ['epub'] } })
    expect(resultSetChanged(BASE, next)).toBe(true)
  })

  it('is true when a facet filter is removed', () => {
    const next = withIdentity({ filters: { authors: ['Herbert'] } })
    expect(resultSetChanged(BASE, next)).toBe(true)
  })

  it('is false when a filter array is only reordered', () => {
    const next = withIdentity({
      filters: { authors: ['Herbert'], tags: ['classic', 'sci-fi'] }
    })
    expect(resultSetChanged(BASE, next)).toBe(false)
  })

  it('is true when filters are cleared', () => {
    expect(resultSetChanged(BASE, withIdentity({ filters: {} }))).toBe(true)
  })

  it('treats an empty-array filter the same as an absent one', () => {
    const withEmptyFormats = withIdentity({ filters: { ...BASE.filters, formats: [] } })
    expect(resultSetChanged(BASE, withEmptyFormats)).toBe(false)
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
    const a = resultSetKey(withIdentity({ filters: { tags: ['a', 'b', 'c'] } }))
    const b = resultSetKey(withIdentity({ filters: { tags: ['c', 'a', 'b'] } }))
    expect(a).toBe(b)
  })
})
