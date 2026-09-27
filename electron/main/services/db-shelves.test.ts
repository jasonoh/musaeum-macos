import Database from 'better-sqlite3'
import { rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, getDb, insertBook } from './db'

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
