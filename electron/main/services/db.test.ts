import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import {
  closeDb,
  getBooks,
  getDb,
  getUnresolvedConflictCount,
  insertBook,
  insertConflict,
  logDeviceTransfer,
  replaceAllBooks,
  searchBooks
} from './db'

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
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
