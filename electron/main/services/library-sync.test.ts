import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBook, getBooks, insertBook } from './db'
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

  it('preserves reading state across a catalog adoption', async () => {
    const book = makeBook('rs-adopt')
    book.readingState = { position: 'epubcfi(/6/4)', percent: 0.6, updatedAt: '2026-08-13T10:00:00Z' }
    await writeCatalog(root, [book])

    await librarySync.applyCatalog(root)

    expect(getBook('rs-adopt')?.readingState).toEqual(book.readingState)
  })

  it('keeps a local reading position that is strictly newer than the catalog', async () => {
    const local = makeBook('rs-local-newer')
    local.readingState = { position: 'cfi-local', percent: 0.5, updatedAt: '2026-08-13T12:00:00Z' }
    insertBook(local)

    const incoming = makeBook('rs-local-newer')
    incoming.readingState = { position: 'cfi-stale', percent: 0.2, updatedAt: '2026-08-13T10:00:00Z' }
    await writeCatalog(root, [incoming])

    await librarySync.applyCatalog(root)
    await librarySync.flushForTests()

    expect(getBook('rs-local-newer')?.readingState).toEqual(local.readingState)
  })

  it('adopts catalog reading state when it is newer than local', async () => {
    const local = makeBook('rs-catalog-newer')
    local.readingState = { position: 'cfi-local', percent: 0.2, updatedAt: '2026-08-13T10:00:00Z' }
    insertBook(local)

    const incoming = makeBook('rs-catalog-newer')
    incoming.readingState = { position: 'cfi-fresh', percent: 0.9, updatedAt: '2026-08-13T12:00:00Z' }
    await writeCatalog(root, [incoming])

    await librarySync.applyCatalog(root)

    expect(getBook('rs-catalog-newer')?.readingState).toEqual(incoming.readingState)
  })

  it('adopts the incoming record when timestamps are equal', async () => {
    const tie = '2026-08-13T11:00:00Z'
    const local = makeBook('rs-tie')
    local.readingState = { position: 'cfi-local', percent: 0.3, updatedAt: tie }
    insertBook(local)

    const incoming = makeBook('rs-tie')
    incoming.readingState = { position: 'cfi-incoming', percent: 0.7, updatedAt: tie }
    await writeCatalog(root, [incoming])

    await librarySync.applyCatalog(root)

    expect(getBook('rs-tie')?.readingState).toEqual(incoming.readingState)
  })

  it('keeps local reading state when the incoming record has none (quit-while-offline)', async () => {
    const local = makeBook('rs-offline-quit')
    local.readingState = { position: 'cfi-stranded', percent: 0.4, updatedAt: '2026-08-13T09:00:00Z' }
    insertBook(local)

    const incoming = makeBook('rs-offline-quit')
    incoming.readingState = null
    await writeCatalog(root, [incoming])

    await librarySync.applyCatalog(root)
    await librarySync.flushForTests()

    expect(getBook('rs-offline-quit')?.readingState).toEqual(local.readingState)
  })

  it('keeps the incoming reading state when there is no local book, without crashing', async () => {
    const incoming = makeBook('rs-no-local')
    incoming.readingState = { position: 'cfi-new-machine', percent: 0.1, updatedAt: '2026-08-13T08:00:00Z' }
    await writeCatalog(root, [incoming])

    await expect(librarySync.applyCatalog(root)).resolves.toBe(1)
    expect(getBook('rs-no-local')?.readingState).toEqual(incoming.readingState)
  })

  it('pushes a locally-won reading state back to catalog.json', async () => {
    const local = makeBook('rs-pushback')
    local.readingState = { position: 'cfi-local', percent: 0.5, updatedAt: '2026-08-13T12:00:00Z' }
    insertBook(local)

    const incoming = makeBook('rs-pushback')
    incoming.readingState = { position: 'cfi-stale', percent: 0.2, updatedAt: '2026-08-13T10:00:00Z' }
    await writeCatalog(root, [incoming])

    await librarySync.applyCatalog(root)
    await librarySync.flushForTests()

    const cat = await readCatalog(root)
    const written = cat?.books.find((b) => b.id === 'rs-pushback')
    expect(written?.readingState).toEqual(local.readingState)
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
