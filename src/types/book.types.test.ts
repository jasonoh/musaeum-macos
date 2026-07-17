import { describe, expect, it } from 'vitest'
import { seriesDisplay } from './book.types'

describe('seriesDisplay', () => {
  it('drops the trailing .0 on whole-number indices', () => {
    expect(seriesDisplay('The Expanse', 1.0)).toBe('The Expanse #1')
  })

  it('keeps fractional indices', () => {
    expect(seriesDisplay('The Expanse', 0.5)).toBe('The Expanse #0.5')
  })

  it('returns the bare name when index is null', () => {
    expect(seriesDisplay('The Expanse', null)).toBe('The Expanse')
  })
})
