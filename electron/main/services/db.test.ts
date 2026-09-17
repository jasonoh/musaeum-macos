import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import {
  closeDb,
  getBook,
  getBooks,
  getDb,
  getUnresolvedConflictCount,
  insertBook,
  insertConflict,
  logDeviceTransfer,
  replaceAllBooks,
  searchBooks,
  setReadingState
} from './db'

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
})

describe('sorting', () => {
  /** Three books that order differently per field. */
  function seedSortable() {
    insertBook({
      ...makeBook('a', 'Charlie'),
      author: 'Adams',
      rating: 1,
      dateAdded: '2026-01-03T00:00:00Z'
    })
    insertBook({
      ...makeBook('b', 'Alpha'),
      author: 'Carter',
      rating: 5,
      dateAdded: '2026-01-01T00:00:00Z'
    })
    insertBook({
      ...makeBook('c', 'Bravo'),
      author: 'Baker',
      rating: 3,
      dateAdded: '2026-01-02T00:00:00Z'
    })
  }

  it('defaults to title ascending', () => {
    seedSortable()
    expect(getBooks().map((b) => b.title)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it.each([
    ['title', 'asc', ['Alpha', 'Bravo', 'Charlie']],
    ['title', 'desc', ['Charlie', 'Bravo', 'Alpha']],
    ['author', 'asc', ['Charlie', 'Bravo', 'Alpha']],
    ['author', 'desc', ['Alpha', 'Bravo', 'Charlie']],
    ['rating', 'desc', ['Alpha', 'Bravo', 'Charlie']],
    ['date_added', 'desc', ['Charlie', 'Bravo', 'Alpha']],
    ['date_added', 'asc', ['Alpha', 'Bravo', 'Charlie']]
  ] as const)('orders by %s %s', (field, direction, expected) => {
    seedSortable()
    expect(getBooks({ sort: { field, direction } }).map((b) => b.title)).toEqual(expected)
  })

  it('applies the direction to every key of a multi-key sort', () => {
    insertBook({ ...makeBook('a', 'Two'), seriesName: 'Expanse', seriesIndex: 2 })
    insertBook({ ...makeBook('b', 'One'), seriesName: 'Expanse', seriesIndex: 1 })
    insertBook({ ...makeBook('c', 'Solo'), seriesName: 'Amber', seriesIndex: 1 })

    const asc = getBooks({ sort: { field: 'series', direction: 'asc' } })
    expect(asc.map((b) => b.title)).toEqual(['Solo', 'One', 'Two'])
    // Descending reverses the whole ordering, not just the index within a series
    const desc = getBooks({ sort: { field: 'series', direction: 'desc' } })
    expect(desc.map((b) => b.title)).toEqual(['Two', 'One', 'Solo'])
  })

  it('falls back to title ascending for an unknown field', () => {
    seedSortable()
    const sort = { field: 'nonsense' as never, direction: 'asc' } as const
    expect(getBooks({ sort }).map((b) => b.title)).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('breaks ties in a fixed order across separate calls, even after physical row order changes', () => {
    // All three tie on author, so nothing in SORT_SQL.author distinguishes
    // them; only the id tiebreak should decide the order.
    insertBook({ ...makeBook('b', 'Bravo'), author: 'Same', rating: 3 })
    insertBook({ ...makeBook('a', 'Alpha'), author: 'Same', rating: 3 })
    insertBook({ ...makeBook('c', 'Charlie'), author: 'Same', rating: 3 })

    const first = getBooks({ sort: { field: 'author', direction: 'asc' } }).map((b) => b.id)

    // Simulate a rewrite that changes physical row order without touching any
    // sort-relevant column — e.g. a re-hydrate that rewrites a row. Without an
    // explicit tiebreak, ties fall back to physical scan order, which this
    // changes; with the id tiebreak the result must not move.
    getDb().prepare('DELETE FROM books WHERE id = ?').run('b')
    insertBook({ ...makeBook('b', 'Bravo'), author: 'Same', rating: 3 })

    const second = getBooks({ sort: { field: 'author', direction: 'asc' } }).map((b) => b.id)

    expect(first).toEqual(['a', 'b', 'c'])
    expect(second).toEqual(first)
  })
})

describe('searchBooks ordering', () => {
  function seedMatches() {
    insertBook({ ...makeBook('a', 'Voyage Charlie'), author: 'Adams' })
    insertBook({ ...makeBook('b', 'Voyage Alpha'), author: 'Carter' })
    insertBook({ ...makeBook('c', 'Voyage Bravo'), author: 'Baker' })
  }

  it('applies the requested sort to matches', () => {
    seedMatches()
    const titles = searchBooks('Voyage', { field: 'author', direction: 'asc' }).map((b) => b.title)
    expect(titles).toEqual(['Voyage Charlie', 'Voyage Bravo', 'Voyage Alpha'])
  })

  it('returns all matches regardless of direction', () => {
    seedMatches()
    expect(searchBooks('Voyage', { field: 'title', direction: 'desc' }).map((b) => b.title)).toEqual(
      ['Voyage Charlie', 'Voyage Bravo', 'Voyage Alpha']
    )
  })

  it('sorts the whole library when the query is only punctuation', () => {
    seedMatches()
    expect(searchBooks('"', { field: 'title', direction: 'desc' }).map((b) => b.title)).toEqual([
      'Voyage Charlie',
      'Voyage Bravo',
      'Voyage Alpha'
    ])
  })

  it('keeps relevance rank when no sort is given', () => {
    seedMatches()
    expect(searchBooks('Voyage').length).toBe(3)
  })
})

describe('replaceAllBooks', () => {
  it('swaps the whole table: removes, updates, inserts', () => {
    insertBook(makeBook('a', 'Alpha'))
    insertBook(makeBook('b', 'Beta'))
    replaceAllBooks([makeBook('b', 'Beta Revised'), makeBook('c', 'Gamma')])
    const byId = new Map(getBooks().map((bk) => [bk.id, bk]))
    expect([...byId.keys()].sort()).toEqual(['b', 'c'])
    expect(byId.get('b')?.title).toBe('Beta Revised')
  })

  it('keeps FTS in sync through the swap', () => {
    insertBook(makeBook('a', 'Distinctive Alpha Title'))
    replaceAllBooks([makeBook('c', 'Unmistakable Gamma Title')])
    expect(searchBooks('Unmistakable').map((b) => b.id)).toEqual(['c'])
    expect(searchBooks('Distinctive')).toEqual([])
  })

  it('tolerates device_history rows for books that vanish', () => {
    insertBook(makeBook('a'))
    logDeviceTransfer('a', 'kindle-1', 'Kindle', 'epub')
    expect(() => replaceAllBooks([makeBook('c')])).not.toThrow()
    const history = getDb().prepare('SELECT book_id FROM device_history').all() as {
      book_id: string
    }[]
    expect(history).toEqual([{ book_id: 'a' }])
  })

  it('prunes conflicts for removed books and keeps the rest', () => {
    insertBook(makeBook('a'))
    insertBook(makeBook('b'))
    insertConflict('a', 'title', [{ source: 'google_books', value: 'X' }])
    insertConflict('b', 'title', [{ source: 'google_books', value: 'Y' }])
    replaceAllBooks([makeBook('b')])
    expect(getUnresolvedConflictCount()).toBe(1)
  })

  it('re-enables foreign keys afterwards', () => {
    replaceAllBooks([])
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1)
  })
})

describe('reading state', () => {
  it('round-trips through insert and read', () => {
    const book = makeBook('rs-1')
    book.readingState = { position: 'epubcfi(/6/4!/2/10)', percent: 0.42, updatedAt: '2026-08-13T10:00:00Z' }
    insertBook(book)

    expect(getBook('rs-1')?.readingState).toEqual({
      position: 'epubcfi(/6/4!/2/10)',
      percent: 0.42,
      updatedAt: '2026-08-13T10:00:00Z'
    })
  })

  it('is null for a book that has never been opened', () => {
    insertBook(makeBook('rs-2'))
    expect(getBook('rs-2')?.readingState).toBeNull()
  })

  it('setReadingState updates in place without touching last_modified', () => {
    const book = makeBook('rs-3')
    book.lastModified = '2020-01-01T00:00:00Z'
    insertBook(book)

    setReadingState('rs-3', { position: 'p1', percent: 0.1, updatedAt: '2026-08-13T10:00:00Z' })

    const updated = getBook('rs-3')!
    expect(updated.readingState?.percent).toBe(0.1)
    // Turning a page is not a metadata edit
    expect(updated.lastModified).toBe('2020-01-01T00:00:00Z')
  })
})
