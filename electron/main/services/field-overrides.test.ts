import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sortableAuthor, sortableTitle } from '@shared/book.types'
import { makeBook } from '../../../test/helpers/book'
import migration001 from '../schema/migrations/001_initial.sql?raw'
import migration002 from '../schema/migrations/002_sort_keys.sql?raw'
import migration003 from '../schema/migrations/003_reading_state.sql?raw'
import migration004 from '../schema/migrations/004_device_file_identity.sql?raw'
import migration005 from '../schema/migrations/005_device_history_outlives_book.sql?raw'
import migration006 from '../schema/migrations/006_shelves.sql?raw'
import { closeDb, getBook, getConfig, getDb, insertBook, updateBook } from './db'
import { list, markFromPatch, release } from './field-overrides'

/**
 * The store behind "a field the user set, which a fetch must not touch".
 *
 * The rule under test is a *difference*: what makes a patch a decision is that
 * it changed something. Marking after the write with the pre-write row is the
 * order both callers use (`library:updateBook`, `conflicts.resolveConflict`) —
 * comparing against the row as it is *after* the write would mark nothing, ever,
 * which is the shape of bug this suite exists to catch.
 */
beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
})

describe('markFromPatch', () => {
  it('locks the fields a patch changed, and only those', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)

    // `author` is in the patch but the row already has that value
    markFromPatch('a', { title: 'Fair Play', author: null }, before)

    expect(list('a')).toEqual(['title'])
  })

  it('stamps the claim and the row with the same instant, so a tie keeps the claim', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)
    const at = '2026-10-11T09:08:07.654Z'

    markFromPatch('a', { author: 'Eve' }, before, at)

    const after = getBook('a')!
    expect(after.lastModified).toBe(at)
    expect(after.ownedFields.author).toBe(at)
  })

  it('accumulates across edits without repeating a field', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)

    markFromPatch('a', { title: 'One' }, before)
    markFromPatch('a', { author: 'Eve Rodsky' }, { ...before, title: 'One' })
    markFromPatch('a', { title: 'Two' }, { ...before, title: 'One' })

    expect(list('a').sort()).toEqual(['author', 'title'])
  })

  it('folds a series and the identifier columns onto one field each', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)

    markFromPatch(
      'a',
      { seriesName: 'The Expanse', seriesIndex: 1, seriesTotal: 9, isbn13: '9781707274123' },
      before
    )

    expect(list('a').sort()).toEqual(['identifiers', 'series'])
  })

  it('does not lock a derived sort key', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)

    markFromPatch('a', { sortTitle: 'Something Else' }, before)

    expect(list('a')).toEqual([])
  })

  it('survives the database closing and reopening', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)
    markFromPatch('a', { title: 'One' }, before)

    closeDb()

    expect(list('a')).toEqual(['title'])
  })
})

describe('release', () => {
  it('releases one field, keeps the value, and leaves the others locked', () => {
    const before = makeBook('a', 'Book a')
    insertBook(before)
    updateBook('a', { title: 'Mine', publisher: 'P' })
    markFromPatch('a', { title: 'Mine', publisher: 'P' }, before)

    expect(release('a', 'title')).toEqual(['publisher'])
    expect(list('a')).toEqual(['publisher'])
    // The value is not touched: releasing is "you may have an opinion again"
    expect(getBook('a')?.title).toBe('Mine')

    expect(release('a', 'publisher')).toEqual([])
    expect(list('a')).toEqual([])
  })

  it('is a no-op for a field that is not locked', () => {
    insertBook(makeBook('a', 'Book a'))
    expect(release('a', 'title')).toEqual([])
  })
})

describe('the claim map on the row', () => {
  it('stamps each claim with the time it was made', () => {
    const before = makeBook('a')
    insertBook(before)
    markFromPatch('a', { author: 'Eve' }, before, '2026-10-11T10:00:00.000Z')
    expect(getBook('a')!.ownedFields).toEqual({ author: '2026-10-11T10:00:00.000Z' })
  })

  it('refreshes the time when a held field is edited again (Review Focus 4)', () => {
    const before = makeBook('a')
    insertBook(before)
    markFromPatch('a', { author: 'Eve' }, before, '2026-10-11T10:00:00.000Z')
    markFromPatch('a', { author: 'Ada' }, { ...before, author: 'Eve' }, '2026-10-11T12:00:00.000Z')
    expect(getBook('a')!.ownedFields).toEqual({ author: '2026-10-11T12:00:00.000Z' })
  })

  it('release removes the entry and bumps last_modified, leaving the value', () => {
    const before = { ...makeBook('a'), lastModified: '2020-01-01T00:00:00.000Z' }
    insertBook(before)
    markFromPatch('a', { author: 'Eve' }, before, '2026-10-11T10:00:00.000Z')
    updateBook('a', { author: 'Eve' })
    release('a', 'author')
    const after = getBook('a')!
    expect(after.ownedFields).toEqual({})
    expect(after.author).toBe('Eve')
    expect(Date.parse(after.lastModified!)).toBeGreaterThan(Date.parse('2026-10-11T10:00:00.000Z'))
  })

  it('releasing a field that is not held leaves last_modified alone', () => {
    insertBook({ ...makeBook('a'), lastModified: '2020-01-01T00:00:00.000Z' })
    release('a', 'title')
    expect(getBook('a')!.lastModified).toBe('2020-01-01T00:00:00.000Z')
  })

  it('a claim for a book that is not in the cache is a no-op, not an error', () => {
    expect(markFromPatch('ghost', { title: 'x' }, null)).toEqual([])
  })
})

describe('an unreadable claim map', () => {
  it('reads as no overrides rather than throwing', () => {
    // A hydration must never fail because this value went bad (invariant 12)
    insertBook(makeBook('a'))
    getDb().prepare('UPDATE books SET owned_fields = ? WHERE id = ?').run('{nope', 'a')
    expect(list('a')).toEqual([])
  })

  it('drops field names it does not know', () => {
    insertBook(makeBook('a'))
    const at = '2026-10-11T10:00:00.000Z'
    getDb()
      .prepare('UPDATE books SET owned_fields = ? WHERE id = ?')
      .run(JSON.stringify({ title: at, nonsense: at }), 'a')
    expect(list('a')).toEqual(['title'])
  })
})

/**
 * The claims used to live in `app_config.field_overrides`, an array of fields
 * per book id. Migration 007 adds the column and the same transaction carries
 * the old map across, once; the key is left in place.
 */
describe('the upgrade seed', () => {
  /** A database exactly as the previous release left it (migrations 001-006), with the given books and `field_overrides` value. */
  function writeV6Database(books: [string, string][], fieldOverrides: string): void {
    const path = join(app.getPath('userData'), 'musaeum.db')
    const old = new Database(path)
    old.function('musaeum_sort_title', (t: unknown) =>
      typeof t === 'string' ? sortableTitle(t) : null
    )
    old.function('musaeum_author_sort', (a: unknown) =>
      typeof a === 'string' ? sortableAuthor(a) : null
    )
    for (const sql of [
      migration001,
      migration002,
      migration003,
      migration004,
      migration005,
      migration006
    ]) {
      old.exec(sql)
    }
    old.pragma('user_version = 6')
    const insert = old.prepare('INSERT INTO books (id, title, last_modified) VALUES (?, ?, ?)')
    for (const [id, lastModified] of books) insert.run(id, `Book ${id}`, lastModified)
    old
      .prepare("INSERT INTO app_config (key, value) VALUES ('field_overrides', ?)")
      .run(fieldOverrides)
    old.close()
  }

  it('turns a pre-upgrade map into records on the books it can resolve (AC6)', () => {
    writeV6Database(
      [
        ['a', '2026-03-04T05:06:07.000Z'],
        ['b', '2026-03-05T05:06:07.000Z']
      ],
      '{"a":["author","title"],"ghost":["tags"],"b":["nope"]}'
    )

    const before = Date.now()
    // The first getDb() runs migrations 007–008
    const a = getBook('a')!
    expect(a.lastModified).toBe('2026-03-04T05:06:07.000Z')
    // One instant for the whole upgrade, not each book's own last_modified: no record written before 007 can carry a release, so the seed must outrank all of them
    const stamps = Object.values(a.ownedFields)
    expect(Object.keys(a.ownedFields).sort()).toEqual(['author', 'title'])
    expect(new Set(stamps).size).toBe(1)
    for (const at of stamps) {
      expect(new Date(at).toISOString()).toBe(at)
      expect(Date.parse(at)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(at)).toBeGreaterThanOrEqual(Date.parse(a.lastModified!))
    }
    expect(getBook('b')!.ownedFields).toEqual({}) // unknown field name dropped
    expect(getBook('ghost')).toBeNull() // no row: nothing created, nothing thrown
    expect(getConfig('field_overrides')).not.toBeNull() // read once, never rewritten, never deleted
    expect(getDb().pragma('user_version', { simple: true })).toBe(8)
  })

  it('stamps every book of one upgrade with the same instant', () => {
    writeV6Database(
      [
        ['a', '2026-03-04T05:06:07.000Z'],
        ['b', '2026-04-05T05:06:07.000Z']
      ],
      '{"a":["author"],"b":["title"]}'
    )
    expect(getBook('a')!.ownedFields.author).toBe(getBook('b')!.ownedFields.title)
  })

  describe('with an unusable field_overrides value', () => {
    const cases: [string, string][] = [
      ['malformed JSON', '{not json'],
      ['an array', '[]'],
      ['a string', '"a string"'],
      [
        'a per-book value that is not an array (valid sibling still seeded)',
        '{"a":"author","b":["title"]}'
      ]
    ]
    it.each(cases)('completes the upgrade and seeds nothing it cannot read: %s', (_name, value) => {
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        writeV6Database(
          [
            ['a', '2026-03-04T05:06:07.000Z'],
            ['b', '2026-03-05T05:06:07.000Z']
          ],
          value
        )
        expect(() => getDb()).not.toThrow()
        expect(getDb().pragma('user_version', { simple: true })).toBe(8)
        expect(getBook('a')!.ownedFields).toEqual({}) // never a usable entry
        const b = getBook('b')!
        if (value.includes('"b":["title"]')) expect(Object.keys(b.ownedFields)).toEqual(['title'])
        else expect(b.ownedFields).toEqual({})
        expect(getConfig('field_overrides')).toBe(value) // left untouched
      } finally {
        quiet.mockRestore()
      }
    })
  })
})
