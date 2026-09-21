import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, getBook, insertBook, setConfig, updateBook } from './db'
import { forget, list, markFromPatch, release } from './field-overrides'

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

describe('an unreadable map', () => {
  it('reads as no overrides rather than throwing', () => {
    // A hydration must never fail because this value went bad (invariant 12)
    insertBook(makeBook('a', 'Book a'))
    setConfig('field_overrides', '{not json')

    expect(list('a')).toEqual([])
  })

  it('drops field names it does not know', () => {
    setConfig('field_overrides', JSON.stringify({ a: ['title', 'nonsense'], b: 'not-an-array' }))

    expect(list('a')).toEqual(['title'])
    expect(list('b')).toEqual([])
  })
})

/**
 * A book that no longer exists cannot be fetched again, so its entry is garbage
 * — and the delete path is where it used to be left behind. Measured on the
 * real library: `app_config.field_overrides` held an id that was not in `books`
 * (six fields, from a book that had been deleted from the detail panel), which
 * is what this pins.
 */
describe('forget', () => {
  it('drops one book’s entry and leaves every other book alone', () => {
    insertBook(makeBook('gone', 'Gone'))
    insertBook(makeBook('kept', 'Kept'))
    markFromPatch('gone', { title: 'Gone Away' }, makeBook('gone', 'Gone'))
    markFromPatch('kept', { title: 'Kept Indeed' }, makeBook('kept', 'Kept'))

    forget('gone')

    expect(list('gone')).toEqual([])
    expect(list('kept')).toEqual(['title'])
  })

  it('is a no-op for a book that never had one', () => {
    expect(() => forget('never-existed')).not.toThrow()
    expect(list('never-existed')).toEqual([])
  })

  /**
   * The two-machine case, which is why the sweep exists at all: a book deleted on
   * the *other* machine comes back to this one as a catalog without it, so the
   * cache loses the row and nobody here deleted anything — no caller forgets it.
   * Confirmed real 2026-09-20 ("I use Musaeum on both machines already"), and
   * exactly the condition D1 of the field-overrides design wrote down as the
   * trigger for making overrides portable.
   */
  it('drops an entry whose book is gone, on the next write', () => {
    insertBook(makeBook('live', 'Live'))
    setConfig('field_overrides', JSON.stringify({ 'dropped-elsewhere': ['title'] }))
    expect(list('dropped-elsewhere')).toEqual(['title'])

    markFromPatch('live', { title: 'Live Indeed' }, makeBook('live', 'Live'))

    expect(list('dropped-elsewhere')).toEqual([])
    expect(list('live')).toEqual(['title'])
  })
})
