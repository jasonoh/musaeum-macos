import { describe, expect, it } from 'vitest'
import { makeBook } from '../../test/helpers/book'
import {
  BOOK_FILE_EXTENSIONS,
  bookFileFilter,
  defaultSortDirection,
  isBookFile,
  isBookSort,
  primaryFormat,
  orderedFormats,
  readableFormat,
  seriesDisplay,
  sortableAuthor,
  sortableTitle,
  sortLabel
} from './book.types'

/**
 * The one declaration of "what is a book file" the on-ramps share.
 *
 * Both consumers are derived from `BOOK_FILE_EXTENSIONS` rather than each
 * holding a copy: the drag-drop gate (`useDragDrop`) and the native picker's
 * filter (`import:fromDialog`). The defect that produced it was a second
 * declaration — the drop gate kept `.epub`/`.mobi`/`.azw3` after Phase 1.5 made
 * PDF first-class, so a dropped PDF was silently discarded.
 */
describe('isBookFile — the drop gate and the picker', () => {
  it('accepts every format the import pipeline supports', () => {
    for (const [format, ext] of Object.entries(BOOK_FILE_EXTENSIONS)) {
      expect(isBookFile(`dune${ext}`), format).toBe(true)
    }
    // AC18, named rather than implied: this is the extension the gate was
    // missing when it owned a list of its own
    expect(isBookFile('dune.pdf')).toBe(true)
  })

  it('matches regardless of case, since Finder hands over the on-disk name', () => {
    expect(isBookFile('Dune.PDF')).toBe(true)
    expect(isBookFile('Dune.EPUB')).toBe(true)
  })

  it('rejects anything else, including a near-miss suffix', () => {
    for (const name of ['cover.jpg', 'notes.txt', 'dune.pdf.part', 'epub', 'dune.epub.part']) {
      expect(isBookFile(name), name).toBe(false)
    }
  })

  it('derives one extension per BookFormat, with the dot', () => {
    const entries = Object.entries(BOOK_FILE_EXTENSIONS)
    // A `BookFormat` added without a mapping reddens `npm run typecheck` — the
    // map is a `Record<BookFormat, string>`, and a union has no runtime members
    // to enumerate, so that is the only place an omission can be caught. What is
    // decidable here is that no entry is a placeholder or a duplicate.
    for (const [format, ext] of entries) {
      expect(ext, format).toBe(`.${format}`)
    }
    expect(new Set(entries.map(([, ext]) => ext)).size).toBe(entries.length)
  })
})

describe('bookFileFilter — the picker offers the same list', () => {
  it('covers every extension in the map, without the dots Electron takes', () => {
    // Derived by iterating the map rather than restating it, so a sixth format
    // lands in the picker on its own. The mutation this pins is a hand-written
    // filter array in the IPC handler.
    expect(bookFileFilter().extensions).toEqual(
      Object.values(BOOK_FILE_EXTENSIONS).map((ext) => ext.slice(1))
    )
  })

  it('offers .pdf and nothing a book importer cannot read', () => {
    const { extensions } = bookFileFilter()
    expect(extensions).toContain('pdf')
    // The theme drop-box's extensions are the near-miss worth naming: a theme
    // file must never be pickable as a book (theming design, AC4.4)
    for (const ext of ['yaml', 'yml', 'itermcolors', 'css']) {
      expect(extensions, ext).not.toContain(ext)
    }
  })

  it('hands Electron bare, non-empty extensions', () => {
    // Electron matches on the extension without its dot; a dotted entry is
    // silently never offered, which is the failure that looks like success
    for (const ext of bookFileFilter().extensions) {
      expect(ext.startsWith('.'), ext).toBe(false)
      expect(ext.length, ext).toBeGreaterThan(0)
    }
  })
})

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

describe('primaryFormat', () => {
  it('names the format the reader would open', () => {
    expect(primaryFormat({ ...makeBook('a'), formats: ['pdf', 'mobi', 'epub'] })).toBe('epub')
    expect(primaryFormat({ ...makeBook('a'), formats: ['mobi', 'azw3'] })).toBe('azw3')
  })

  it('names a pdf-only book pdf, where readableFormat answers null', () => {
    expect(primaryFormat({ ...makeBook('a'), formats: ['pdf'] })).toBe('pdf')
  })

  it('prefers an epub over a pdf when a book has both', () => {
    expect(primaryFormat({ ...makeBook('a'), formats: ['pdf', 'epub'] })).toBe('epub')
  })

  it('returns null for a book with no files', () => {
    expect(primaryFormat({ ...makeBook('a'), formats: [] })).toBeNull()
  })
})

describe('orderedFormats', () => {
  it('reads in preference order regardless of how the array was stored', () => {
    expect(orderedFormats({ ...makeBook('a'), formats: ['pdf', 'mobi', 'epub'] })).toEqual([
      'epub',
      'mobi',
      'pdf'
    ])
    expect(orderedFormats({ ...makeBook('a'), formats: ['mobi', 'epub'] })).toEqual([
      'epub',
      'mobi'
    ])
  })

  it('keeps a format the order does not know, after the ones it does', () => {
    expect(orderedFormats({ ...makeBook('a'), formats: ['pdf', 'epub'] })).toEqual(['epub', 'pdf'])
  })

  it('is empty for a book with no files', () => {
    expect(orderedFormats({ ...makeBook('a'), formats: [] })).toEqual([])
  })
})

describe('shelf_added — the sort that only exists inside a shelf (bookshelves D8)', () => {
  it('is a sort the guard accepts, newest first on first click, with its own labels', () => {
    expect(isBookSort({ field: 'shelf_added', direction: 'desc' })).toBe(true)
    expect(defaultSortDirection('shelf_added')).toBe('desc')
    expect(sortLabel({ field: 'shelf_added', direction: 'desc' })).toBe(
      'Date Added to Shelf, Newest First'
    )
    expect(sortLabel({ field: 'shelf_added', direction: 'asc' })).toBe(
      'Date Added to Shelf, Oldest First'
    )
  })
})
