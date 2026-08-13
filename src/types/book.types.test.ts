import { describe, expect, it } from 'vitest'
import { makeBook } from '../../test/helpers/book'
import { readableFormat, seriesDisplay, sortableAuthor, sortableTitle } from './book.types'

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

describe('sortableTitle', () => {
  it('moves a leading article to the end', () => {
    expect(sortableTitle('The Great Gatsby')).toBe('Great Gatsby, The')
    expect(sortableTitle('An Ember in the Ashes')).toBe('Ember in the Ashes, An')
  })

  it('leaves titles without a leading article alone', () => {
    expect(sortableTitle('Leviathan Wakes')).toBe('Leviathan Wakes')
    expect(sortableTitle('Theft of Fire')).toBe('Theft of Fire')
  })
})

describe('sortableAuthor', () => {
  it('inverts a plain name', () => {
    expect(sortableAuthor('Seth Dickinson')).toBe('Dickinson, Seth')
    expect(sortableAuthor('James S.A. Corey')).toBe('Corey, James S.A.')
  })

  it('keeps surname particles with the surname', () => {
    expect(sortableAuthor('Ursula K. Le Guin')).toBe('Le Guin, Ursula K.')
    expect(sortableAuthor('Ludwig van Beethoven')).toBe('van Beethoven, Ludwig')
  })

  it('keeps a generational suffix with the surname', () => {
    expect(sortableAuthor('Martin Luther King Jr.')).toBe('King Jr., Martin Luther')
  })

  it('passes through names it would only mangle', () => {
    expect(sortableAuthor('Dickinson, Seth')).toBe('Dickinson, Seth')
    expect(sortableAuthor('Neil Gaiman & Terry Pratchett')).toBe('Neil Gaiman & Terry Pratchett')
    expect(sortableAuthor('Homer')).toBe('Homer')
    expect(sortableAuthor(null)).toBeNull()
    expect(sortableAuthor('   ')).toBeNull()
  })
})

describe('readableFormat', () => {
  it('prefers epub', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['pdf', 'mobi', 'epub'] })).toBe('epub')
  })

  it('falls back to azw3 before mobi', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['mobi', 'azw3'] })).toBe('azw3')
  })

  it('reads a mobi-only book', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['mobi'] })).toBe('mobi')
  })

  it('returns null for a pdf-only book, which C1 cannot render', () => {
    expect(readableFormat({ ...makeBook('a'), formats: ['pdf'] })).toBeNull()
  })

  it('returns null for a book with no files', () => {
    expect(readableFormat({ ...makeBook('a'), formats: [] })).toBeNull()
  })
})
