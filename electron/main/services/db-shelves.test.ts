import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ManualShelfEntry, ShelfEntry, ShelvesFile } from '@shared/shelf.types'
import { makeBook } from '../../../test/helpers/book'
import {
  closeDb,
  countBooks,
  deleteBook,
  getBooks,
  getBooksPage,
  getDb,
  getFacets,
  insertBook,
  listShelves,
  listShelvesWithUpdatedAt,
  replaceAllBooks,
  replaceAllShelves,
  searchBooks,
  searchBooksPage,
  shelfExists,
  shelfIdsForBooks,
  shelvesForBook
} from './db'

const dbPath = (): string => join(app.getPath('userData'), 'musaeum.db')

beforeEach(() => {
  closeDb()
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(app.getPath('userData'), f), { force: true })
  }
})

/**
 * Put a fully migrated database back to the shape it had at user_version 5:
 * the shelf cache gone, 001's collections tables back. Closing and reopening
 * then runs 006 over it exactly as it runs on a real machine's database.
 */
function rewindTo005(): void {
  const d = getDb()
  d.exec(`
    DROP TABLE shelf_books;
    DROP TABLE shelves;
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
    CREATE TABLE book_collections (
      book_id       TEXT REFERENCES books(id),
      collection_id TEXT REFERENCES collections(id),
      PRIMARY KEY (book_id, collection_id)
    );
  `)
  d.pragma('user_version = 5')
}

function schemaNames(d: Database.Database): string[] {
  return (
    d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as {
      name: string
    }[]
  ).map((r) => r.name)
}

describe('migration 006 (bookshelves D2)', () => {
  it('replaces the collections tables with the shelf cache and leaves every book row untouched', () => {
    insertBook({ ...makeBook('a', 'Alpha'), author: 'Adams', rating: 4 })
    insertBook(makeBook('b', 'Bravo'))
    rewindTo005()
    const before = getDb().prepare('SELECT * FROM books ORDER BY id').all()
    closeDb()

    const d = getDb()
    expect(d.pragma('user_version', { simple: true })).toBe(6)
    const names = schemaNames(d)
    expect(names).toEqual(
      expect.arrayContaining(['shelves', 'shelf_books', 'idx_shelf_books_book'])
    )
    expect(names).not.toContain('collections')
    expect(names).not.toContain('book_collections')
    expect(d.prepare('SELECT * FROM books ORDER BY id').all()).toEqual(before)
  })

  it('refuses to drop a collections table that holds rows, and leaves the database at 5', () => {
    insertBook(makeBook('a'))
    rewindTo005()
    getDb().prepare("INSERT INTO collections (id, name) VALUES ('c1', 'Kept')").run()
    closeDb()

    expect(() => getDb()).toThrow(/collections_must_be_empty_before_006/)
    // A half-migrated connection must not linger: a second call throws too,
    // rather than silently handing back a db stuck between migrations (M3)
    expect(() => getDb()).toThrow(/collections_must_be_empty_before_006/)
    closeDb()
    const raw = new Database(dbPath(), { readonly: true })
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(5)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM collections').get()).toEqual({ n: 1 })
    } finally {
      raw.close()
    }
  })
})

const T = (day: number): string => `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`

function manualShelf(id: string, name: string, members: [string, string][]): ManualShelfEntry {
  return {
    id,
    name,
    kind: 'manual',
    created_at: T(1),
    updated_at: T(1),
    books: members.map(([bookId, at]) => ({ id: bookId, added_at: at }))
  }
}

function file(shelves: ShelfEntry[]): ShelvesFile {
  return { version: 1, shelves }
}

const ids = (books: { id: string }[]): string[] => books.map((b) => b.id)

/**
 * Four books. `s1` "To Read" holds b (day 2), c (day 1), d (day 3) and a book
 * this library does not have; `s2` "alpha" holds a; `s3` is a smart shelf.
 */
function seed(): void {
  insertBook({ ...makeBook('a', 'Alpha Voyage'), author: 'Adams' })
  insertBook({ ...makeBook('b', 'Bravo Voyage'), author: 'Baker' })
  insertBook({ ...makeBook('c', 'Charlie'), author: 'Carter' })
  insertBook({ ...makeBook('d', 'Delta Voyage'), author: 'Baker' })
  replaceAllShelves(
    file([
      manualShelf('s1', 'To Read', [
        ['b', T(2)],
        ['c', T(1)],
        ['d', T(3)],
        ['imported-elsewhere', T(4)]
      ]),
      manualShelf('s2', 'alpha', [['a', T(1)]]),
      { id: 's3', kind: 'smart', name: 'Smart', rule: {} }
    ])
  )
}

describe('the shelf cache (bookshelves D2, D4, D6)', () => {
  it('lists manual shelves alphabetically, case-insensitively, counting only books the library holds', () => {
    seed()
    expect(listShelves()).toEqual([
      { id: 's2', name: 'alpha', kind: 'manual', count: 1 },
      { id: 's1', name: 'To Read', kind: 'manual', count: 3 }
    ])
  })

  it('names the shelves a book is on, and none for a book on no shelf', () => {
    seed()
    expect(shelvesForBook('b')).toEqual([{ id: 's1', name: 'To Read', kind: 'manual', count: 3 }])
    expect(shelvesForBook('imported-elsewhere')).toEqual([])
    insertBook(makeBook('e'))
    expect(shelvesForBook('e')).toEqual([])
  })

  it('survives a hand-edited file that repeats a shelf or a member — the first occurrence wins', () => {
    insertBook(makeBook('a'))
    insertBook(makeBook('b'))
    expect(() =>
      replaceAllShelves(
        file([
          manualShelf('s1', 'One', [
            ['a', T(1)],
            ['a', T(2)]
          ]),
          manualShelf('s1', 'Duplicate', [['b', T(1)]])
        ])
      )
    ).not.toThrow()
    expect(listShelves()).toEqual([{ id: 's1', name: 'One', kind: 'manual', count: 1 }])
    expect(getDb().prepare('SELECT added_at FROM shelf_books WHERE book_id = ?').get('a')).toEqual({
      added_at: T(1)
    })
  })

  it('replaces the whole cache, so a file with no shelves empties it', () => {
    seed()
    replaceAllShelves(file([]))
    expect(listShelves()).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM shelf_books').get()).toEqual({ n: 0 })
  })

  it('drops a deleted book from the cache, and so does a swap that no longer holds it', () => {
    seed()
    deleteBook('b')
    expect(listShelves().find((s) => s.id === 's1')?.count).toBe(2)
    replaceAllBooks([makeBook('a'), makeBook('d')])
    expect(listShelves().find((s) => s.id === 's1')?.count).toBe(1)
  })
})

describe('a shelf as a scope on every library read (bookshelves D7, D8)', () => {
  it('scopes getBooks, the page read and the count through the shared WHERE builder', () => {
    seed()
    expect(ids(getBooks({ shelfId: 's1' }))).toEqual(['b', 'c', 'd'])
    expect(countBooks({ shelfId: 's1' })).toBe(3)
    const page = getBooksPage({ shelfId: 's1' }, { limit: 1, offset: 1 })
    expect(ids(page.books)).toEqual(['c'])
    expect(page.total).toBe(3)
    // …and composes with the facet filters rather than replacing them
    expect(ids(getBooks({ shelfId: 's1', authors: ['Baker'] }))).toEqual(['b', 'd'])
  })

  it('orders shelf_added by when each book was shelved, in both directions', () => {
    seed()
    const shelfAdded = (direction: 'asc' | 'desc') =>
      ids(getBooks({ shelfId: 's1', sort: { field: 'shelf_added', direction } }))
    expect(shelfAdded('desc')).toEqual(['d', 'b', 'c'])
    expect(shelfAdded('asc')).toEqual(['c', 'b', 'd'])
  })

  it('breaks a shelf_added tie by id ascending, whatever the direction', () => {
    insertBook(makeBook('b'))
    insertBook(makeBook('c'))
    replaceAllShelves(
      file([
        manualShelf('s1', 'Tied', [
          ['c', T(1)],
          ['b', T(1)]
        ])
      ])
    )
    for (const direction of ['asc', 'desc'] as const) {
      expect(ids(getBooks({ shelfId: 's1', sort: { field: 'shelf_added', direction } }))).toEqual([
        'b',
        'c'
      ])
    }
  })

  it('binds the shelf sort ahead of the page, so a paged shelf_added read is the right slice', () => {
    seed()
    const page = getBooksPage(
      { shelfId: 's1', sort: { field: 'shelf_added', direction: 'desc' } },
      { limit: 2, offset: 1 }
    )
    expect(ids(page.books)).toEqual(['b', 'c'])
    expect(page.total).toBe(3)
  })

  it('falls back to title for shelf_added without a shelf, and never throws', () => {
    seed()
    expect(ids(getBooks({ sort: { field: 'shelf_added', direction: 'desc' } }))).toEqual(
      ids(getBooks({ sort: { field: 'title', direction: 'desc' } }))
    )
  })

  it('scopes the facets to the shelf, and leaves the unscoped facets as they were', () => {
    seed()
    const scoped = getFacets({ shelfId: 's1' })
    expect(scoped.authors).toEqual([
      { value: 'Baker', count: 2 },
      { value: 'Carter', count: 1 }
    ])
    expect(scoped.readStatus).toEqual([{ value: 'unread', count: 3 }])
    expect(scoped.formats).toEqual([{ value: 'epub', count: 3 }])
    expect(getFacets().authors).toEqual([
      { value: 'Baker', count: 2 },
      { value: 'Adams', count: 1 },
      { value: 'Carter', count: 1 }
    ])
  })

  it('searches only the shelf, in any sort, including shelf_added', () => {
    seed()
    expect(ids(searchBooks('Voyage')).sort()).toEqual(['a', 'b', 'd'])
    expect(ids(searchBooks('Voyage', undefined, { shelfId: 's1' })).sort()).toEqual(['b', 'd'])
    expect(
      ids(searchBooks('Voyage', { field: 'shelf_added', direction: 'desc' }, { shelfId: 's1' }))
    ).toEqual(['d', 'b'])
    const page = searchBooksPage(
      'Voyage',
      { limit: 1, offset: 0 },
      { shelfId: 's1', sort: { field: 'shelf_added', direction: 'desc' } }
    )
    expect(ids(page.books)).toEqual(['d'])
    expect(page.total).toBe(2)
  })
})

describe('the reads the REST surface answers from (slice 5)', () => {
  it('shelfExists answers for the cache, and is false for a shelf out of it', () => {
    seed()
    expect(shelfExists('s1')).toBe(true)
    expect(shelfExists('s2')).toBe(true)
    // The smart shelf is in the file and out of the cache (D1) — not a shelf
    // this surface can be asked about, which is why the check reads the cache
    expect(shelfExists('s3')).toBe(false)
    expect(shelfExists('gone')).toBe(false)
  })

  it('shelfIdsForBooks answers every book in one call, in listShelves order', () => {
    insertBook(makeBook('a'))
    insertBook(makeBook('b'))
    insertBook(makeBook('c'))
    replaceAllShelves(
      file([
        manualShelf('s2', 'alpha', [['a', T(1)]]),
        manualShelf('s1', 'To Read', [
          ['a', T(2)],
          ['b', T(2)]
        ])
      ])
    )

    const found = shelfIdsForBooks(['a', 'b', 'c'])
    // The order is `listShelves`'s own — name COLLATE NOCASE, then id — so the
    // wire's array and the sidebar cannot disagree about which shelf comes first
    expect(found.get('a')).toEqual(['s2', 's1'])
    expect(found.get('b')).toEqual(['s1'])
    // A book on nothing is absent from the map rather than mapped to `[]`; the
    // reader pads, and one blank key set would otherwise have to exist for every
    // book in the library
    expect(found.has('c')).toBe(false)
    expect(shelfIdsForBooks([])).toEqual(new Map())
  })

  it('listShelvesWithUpdatedAt carries the file own clock, and agrees with listShelves', () => {
    seed()
    expect(listShelvesWithUpdatedAt()).toEqual([
      { id: 's2', name: 'alpha', kind: 'manual', count: 1, updatedAt: T(1) },
      { id: 's1', name: 'To Read', kind: 'manual', count: 3, updatedAt: T(1) }
    ])

    // The clock is the shelf row's own, not the query's
    replaceAllShelves(file([{ ...manualShelf('s1', 'To Read', [['b', T(2)]]), updated_at: T(9) }]))
    expect(listShelvesWithUpdatedAt()).toEqual([
      { id: 's1', name: 'To Read', kind: 'manual', count: 1, updatedAt: T(9) }
    ])
    // One SQL statement, two readers: the summary is a projection of this one,
    // so the two cannot order or count differently
    expect(listShelves()).toEqual([{ id: 's1', name: 'To Read', kind: 'manual', count: 1 }])
  })
})
