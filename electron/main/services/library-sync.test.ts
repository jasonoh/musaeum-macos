import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBooks, insertBook } from './db'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

let root: string

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-sync-'))
  await nas.setLibraryRoot(root) // temp dir exists → state becomes 'connected'
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('syncOnConnect', () => {
  it('adopts an existing catalog into the local cache', async () => {
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    await librarySync.syncOnConnect()
    expect(getBooks().map((b) => b.id).sort()).toEqual(['a', 'b'])
  })

  it('bootstraps the catalog from a non-empty local cache when missing', async () => {
    insertBook(makeBook('local-1'))
    await librarySync.syncOnConnect()
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['local-1'])
  })

  it('runs once per root per session', async () => {
    await writeCatalog(root, [makeBook('a')])
    await librarySync.syncOnConnect()
    insertBook(makeBook('locally-added'))
    await librarySync.syncOnConnect() // must not re-apply and wipe the new book
    expect(getBooks().length).toBe(2)
  })

  it('does not apply after skipRoot', async () => {
    await writeCatalog(root, [makeBook('a')])
    librarySync.skipRoot(root)
    await librarySync.syncOnConnect()
    expect(getBooks()).toEqual([])
  })

  it('never bootstraps over a corrupt catalog, and never replaces the local cache', async () => {
    await fs.writeFile(join(root, 'catalog.json'), 'not json{', 'utf8')
    const before = await fs.readFile(join(root, 'catalog.json'), 'utf8')
    insertBook(makeBook('local-1'))
    await librarySync.syncOnConnect()
    const after = await fs.readFile(join(root, 'catalog.json'), 'utf8')
    expect(after).toBe(before)
    expect(getBooks().map((b) => b.id)).toEqual(['local-1'])
  })
})

describe('applyCatalog', () => {
  it('replaces the cache and returns the count', async () => {
    insertBook(makeBook('stale'))
    await writeCatalog(root, [makeBook('a'), makeBook('b')])
    const count = await librarySync.applyCatalog(root)
    expect(count).toBe(2)
    expect(getBooks().map((b) => b.id).sort()).toEqual(['a', 'b'])
  })
})

describe('refreshLibrary', () => {
  it('reloads the cache from the catalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    const result = await librarySync.refreshLibrary()
    expect(result).toEqual({ books: 1 })
    expect(getBooks().map((b) => b.id)).toEqual(['a'])
  })

  it('falls back to a rebuild walk when no catalog exists', async () => {
    const dir = join(root, 'books', 'uuid-9')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id: 'uuid-9', title: 'Walked' }))
    const result = await librarySync.refreshLibrary()
    expect(result).toEqual({ books: 1 })
    expect(getBooks()[0]?.title).toBe('Walked')
    expect((await readCatalog(root))?.books.length).toBe(1)
  })
})

describe('upsertCatalog / removeBookFromCatalog', () => {
  it('are asynchronous no-op-safe helpers that land in the catalog', async () => {
    await writeCatalog(root, [makeBook('a')])
    librarySync.upsertCatalog([makeBook('b')])
    librarySync.removeBookFromCatalog('a')
    await librarySync.flushForTests()
    const cat = await readCatalog(root)
    expect(cat?.books.map((b) => b.id)).toEqual(['b'])
  })
})
