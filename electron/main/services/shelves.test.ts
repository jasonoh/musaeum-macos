import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualShelfEntry, ShelvesFile } from '@shared/shelf.types'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, getBooks, insertBook } from './db'
import { subscribe } from './events'
import * as nas from './nas-manager'
import * as shelves from './shelves'
import { readShelvesFile, shelvesPath, writeShelvesFile } from './shelves-file'

let root: string

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  shelves.resetAdoptionLogForTests() // module-level; would otherwise carry over between tests
  root = mkdtempSync(join(tmpdir(), 'musaeum-shelves-'))
  await nas.setLibraryRoot(root) // temp dir exists → state becomes 'connected'
  for (const id of ['a', 'b', 'c']) insertBook(makeBook(id))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** shelves.json as it is on the share now. */
async function onDisk(): Promise<ShelvesFile> {
  const read = await readShelvesFile(root)
  if (read.state !== 'ok') throw new Error(`shelves.json is ${read.state}`)
  return read.file
}

function manualOnDisk(file: ShelvesFile, id: string): ManualShelfEntry {
  const shelf = file.shelves.find((s) => s.id === id)
  if (!shelf || shelf.kind !== 'manual') throw new Error(`no manual shelf ${id} on disk`)
  return shelf as ManualShelfEntry
}

/** A shelves.json scratch file: `shelves.json.<uuid>.part`, one per write (F2). */
function isShelvesScratch(path: unknown): boolean {
  const name = basename(String(path))
  return name.startsWith('shelves.json.') && name.endsWith('.part')
}

/** Counts writes of shelves.json from here on — every write goes through its scratch file. */
function countWrites(): () => number {
  const spy = vi.spyOn(fs, 'writeFile')
  return () => spy.mock.calls.filter(([path]) => isShelvesScratch(path)).length
}

describe('writes: file first, cache second, one write each (bookshelves D3)', () => {
  it('create, addBooks and removeBooks each write once and leave file and cache agreeing (AC2)', async () => {
    const writes = countWrites()
    const shelf = await shelves.create('To Read')
    expect(writes()).toBe(1)
    expect(shelf).toEqual({ id: shelf.id, name: 'To Read', kind: 'manual', count: 0 })

    expect(await shelves.addBooks(shelf.id, ['a', 'b'])).toEqual({ added: 2, alreadyOn: 0 })
    expect(writes()).toBe(2)

    const removed = await shelves.removeBooks(shelf.id, ['a'])
    expect(writes()).toBe(3)
    expect(removed.map((m) => m.bookId)).toEqual(['a'])

    expect(manualOnDisk(await onDisk(), shelf.id).books.map((m) => m.id)).toEqual(['b'])
    expect(shelves.list()).toEqual([{ id: shelf.id, name: 'To Read', kind: 'manual', count: 1 }])
    expect(getBooks({ shelfId: shelf.id }).map((b) => b.id)).toEqual(['b'])
  })

  it('creates a shelf with books in the same single write, skipping ids the library does not hold', async () => {
    const writes = countWrites()
    const shelf = await shelves.create('Favourites', ['a', 'not-a-book', 'a'])
    expect(writes()).toBe(1)
    expect(shelf.count).toBe(1)
    expect(manualOnDisk(await onDisk(), shelf.id).books.map((m) => m.id)).toEqual(['a'])
  })

  it('serializes mutations started together, each over a fresh read, so all of them land (AC3)', async () => {
    const shelf = await shelves.create('To Read')
    await Promise.all([
      shelves.addBooks(shelf.id, ['a']),
      shelves.addBooks(shelf.id, ['b']),
      shelves.create('Second')
    ])
    const disk = await onDisk()
    expect(
      manualOnDisk(disk, shelf.id)
        .books.map((m) => m.id)
        .sort()
    ).toEqual(['a', 'b'])
    expect(disk.shelves).toHaveLength(2)
  })

  it('addBooks is idempotent: alreadyOn the second time, the first added_at kept, no write for a no-op (AC4)', async () => {
    const shelf = await shelves.create('To Read')
    await shelves.addBooks(shelf.id, ['a'])
    const first = manualOnDisk(await onDisk(), shelf.id).books[0].added_at
    const writes = countWrites()

    expect(await shelves.addBooks(shelf.id, ['a', 'b'])).toEqual({ added: 1, alreadyOn: 1 })
    expect(await shelves.addBooks(shelf.id, ['a', 'b'])).toEqual({ added: 0, alreadyOn: 2 })
    expect(writes()).toBe(1)
    expect(manualOnDisk(await onDisk(), shelf.id).books.find((m) => m.id === 'a')?.added_at).toBe(
      first
    )
  })

  it('skips ids the library does not hold, and counts them nowhere', async () => {
    const shelf = await shelves.create('To Read')
    expect(await shelves.addBooks(shelf.id, ['not-a-book'])).toEqual({ added: 0, alreadyOn: 0 })
  })

  it('removeBooks then restoreBooks round-trips every added_at exactly (AC5)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    const shelf = await shelves.create('To Read', ['a'])
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
    await shelves.addBooks(shelf.id, ['b'])
    const before = manualOnDisk(await onDisk(), shelf.id).books

    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'))
    const removed = await shelves.removeBooks(shelf.id, ['a', 'b'])
    expect(removed).toEqual([
      { bookId: 'a', addedAt: '2026-09-01T00:00:00.000Z' },
      { bookId: 'b', addedAt: '2026-09-02T00:00:00.000Z' }
    ])
    await shelves.restoreBooks(shelf.id, removed)

    const byId = (list: { id: string }[]) => [...list].sort((x, y) => x.id.localeCompare(y.id))
    expect(byId(manualOnDisk(await onDisk(), shelf.id).books)).toEqual(byId(before))
    expect(
      getBooks({ shelfId: shelf.id, sort: { field: 'shelf_added', direction: 'desc' } }).map(
        (b) => b.id
      )
    ).toEqual(['b', 'a'])
  })

  it('restoreBooks keeps a member that is already back, and ignores what is not a membership', async () => {
    const shelf = await shelves.create('To Read', ['a'])
    const [original] = await shelves.removeBooks(shelf.id, ['a'])
    await shelves.addBooks(shelf.id, ['a']) // re-added before the Undo
    const readded = manualOnDisk(await onDisk(), shelf.id).books[0].added_at
    await shelves.restoreBooks(shelf.id, [
      original,
      { bookId: 'b', addedAt: '' },
      { bookId: 7, addedAt: 'x' } as unknown as { bookId: string; addedAt: string }
    ])
    const books = manualOnDisk(await onDisk(), shelf.id).books
    expect(books).toEqual([{ id: 'a', added_at: readded }])
  })

  it('leaves file and cache as they were when the share write fails, and the next change still lands', async () => {
    const shelf = await shelves.create('To Read', ['a'])
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('share dropped'))

    await expect(shelves.addBooks(shelf.id, ['b'])).rejects.toThrow('share dropped')
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    expect(shelves.list()[0].count).toBe(1)

    await expect(shelves.addBooks(shelf.id, ['b'])).resolves.toEqual({ added: 1, alreadyOn: 0 })
    expect(shelves.list()[0].count).toBe(2)
  })

  it('names the shelves a book is on', async () => {
    const one = await shelves.create('One', ['a'])
    await shelves.create('Two', ['b'])
    expect(shelves.forBook('a')).toEqual([{ id: one.id, name: 'One', kind: 'manual', count: 1 }])
    expect(shelves.forBook('c')).toEqual([])
  })
})

describe('names (bookshelves D3, AC10)', () => {
  it.each([
    ['empty', '', /needs a name/],
    ['whitespace only', '  \t ', /needs a name/],
    ['81 characters', 'x'.repeat(81), /at most 80 characters/]
  ])('refuses a name that is %s, and writes nothing', async (_label, name, message) => {
    await expect(shelves.create(name)).rejects.toThrow(message)
    await expect(fs.access(shelvesPath(root))).rejects.toThrow()
  })

  it('trims, and allows exactly 80 characters', async () => {
    expect((await shelves.create('  To Read  ')).name).toBe('To Read')
    expect((await shelves.create('y'.repeat(80))).name).toBe('y'.repeat(80))
  })

  it('refuses a case-insensitive duplicate rather than suffixing it', async () => {
    await shelves.create('To Read')
    await expect(shelves.create('to read')).rejects.toThrow(
      'There is already a shelf named “To Read”.'
    )
    expect(shelves.list().map((s) => s.name)).toEqual(['To Read'])
  })
})

const AT = '2026-09-01T00:00:00.000Z'

/** Every mutation, pointed at shelf `id` — for the refusals every one of them shares. */
function everyMutation(id: string): [string, () => Promise<unknown>][] {
  return [
    ['create', () => shelves.create('Brand New')],
    ['rename', () => shelves.rename(id, 'Renamed')],
    ['deleteShelf', () => shelves.deleteShelf(id)],
    ['addBooks', () => shelves.addBooks(id, ['c'])],
    ['removeBooks', () => shelves.removeBooks(id, ['a'])],
    ['restoreBooks', () => shelves.restoreBooks(id, [{ bookId: 'b', addedAt: AT }])],
    ['pruneBooks', () => shelves.pruneBooks(['a'])]
  ]
}

describe('rename and delete', () => {
  it('lets a shelf take its own name in another case, and refuses another shelf’s (AC10)', async () => {
    const shelf = await shelves.create('To Read')
    const other = await shelves.create('Later')
    await shelves.rename(shelf.id, 'TO READ')
    expect(shelves.list().find((s) => s.id === shelf.id)?.name).toBe('TO READ')
    await expect(shelves.rename(other.id, '  to read ')).rejects.toThrow(
      'There is already a shelf named “TO READ”.'
    )
  })

  it('deletes the shelf and leaves every book in the library', async () => {
    const shelf = await shelves.create('To Read', ['a', 'b'])
    await shelves.deleteShelf(shelf.id)
    expect(shelves.list()).toEqual([])
    expect((await onDisk()).shelves).toEqual([])
    expect(getBooks().map((b) => b.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('refusals every mutation shares', () => {
  it.each([
    ['invalid JSON', 'not json{'],
    ['an unknown version', JSON.stringify({ version: 2, shelves: [] })]
  ])(
    'refuses every mutation over %s, and never rewrites the file (AC6, AC9)',
    async (_label, text) => {
      await fs.writeFile(shelvesPath(root), text, 'utf8')
      for (const [name, call] of everyMutation('s1')) {
        await expect(call(), name).rejects.toThrow(shelves.SHELVES_UNREADABLE)
      }
      expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(text)
    }
  )

  it('refuses every change to a shelf deleted on another Mac, drops it from the cache, and leaves the file alone (AC8)', async () => {
    const shelf = await shelves.create('Doomed', ['a'])
    await writeShelvesFile(root, { version: 1, shelves: [] }) // another Mac deleted it
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    const events: string[] = []
    const unsubscribe = subscribe((event) => {
      events.push(event)
    })

    const onShelf = everyMutation(shelf.id).filter(([name]) =>
      ['rename', 'deleteShelf', 'addBooks', 'removeBooks', 'restoreBooks'].includes(name)
    )
    for (const [name, call] of onShelf) {
      await expect(call(), name).rejects.toThrow(shelves.SHELF_GONE)
    }
    unsubscribe()

    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    expect(shelves.list()).toEqual([])
    expect(events.filter((e) => e === 'shelvesChanged')).toHaveLength(5)
  })

  it('refuses every mutation while the library is unreachable, changing neither file nor cache (AC15)', async () => {
    const shelf = await shelves.create('To Read', ['a'])
    const before = await fs.readFile(shelvesPath(root), 'utf8')
    const cached = shelves.list()
    await nas.setLibraryRoot(join(root, 'does-not-exist'))

    for (const [name, call] of everyMutation(shelf.id)) {
      await expect(call(), name).rejects.toThrow(/missing|offline/)
    }
    expect(await fs.readFile(shelvesPath(root), 'utf8')).toBe(before)
    expect(shelves.list()).toEqual(cached)
  })
})

describe('pruneBooks (bookshelves D5)', () => {
  it('takes books off every shelf in one write', async () => {
    const one = await shelves.create('One', ['a', 'b'])
    const two = await shelves.create('Two', ['b', 'c'])
    const writes = countWrites()
    await shelves.pruneBooks(['a', 'b'])
    expect(writes()).toBe(1)
    const disk = await onDisk()
    expect(manualOnDisk(disk, one.id).books).toEqual([])
    expect(manualOnDisk(disk, two.id).books.map((m) => m.id)).toEqual(['c'])
  })

  it('writes nothing when no shelf holds the books, and creates no file where there was none', async () => {
    const writes = countWrites()
    await shelves.pruneBooks(['a'])
    expect(writes()).toBe(0)
    await expect(fs.access(shelvesPath(root))).rejects.toThrow()
  })
})

describe('adopt (bookshelves D4)', () => {
  it('skips a kind it does not know for the cache, and a later write carries it back unchanged (AC7)', async () => {
    const smart = {
      id: 'smart-1',
      kind: 'smart',
      name: 'Unread SF',
      rule: { tags: ['sf'], readStatus: 'unread' },
      future: [1, 2, 3]
    }
    const manual: ManualShelfEntry = {
      id: 'manual-1',
      name: 'To Read',
      kind: 'manual',
      created_at: AT,
      updated_at: AT,
      books: []
    }
    await writeShelvesFile(root, { version: 1, shelves: [smart, manual] })
    await shelves.adopt(root)
    expect(shelves.list().map((s) => s.id)).toEqual(['manual-1'])

    await shelves.addBooks('manual-1', ['a'])
    const carried = (await onDisk()).shelves.find((s) => s.id === 'smart-1')
    expect(JSON.stringify(carried)).toBe(JSON.stringify(smart))
  })

  it('never rejects, and keeps the cache when the file is unreadable', async () => {
    await shelves.create('To Read', ['a'])
    const cached = shelves.list()
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(shelves.adopt(root)).resolves.toBeUndefined()
    expect(shelves.list()).toEqual(cached)
    expect(error).toHaveBeenCalled()
  })

  it('logs an unreadable file again if it breaks again after being repaired (M2)', async () => {
    await shelves.create('To Read', ['a'])
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    await shelves.adopt(root)
    await shelves.adopt(root) // still broken: not logged a second time
    expect(error).toHaveBeenCalledTimes(1)

    await writeShelvesFile(root, { version: 1, shelves: [] }) // repaired
    await shelves.adopt(root)
    expect(shelves.list()).toEqual([])

    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8') // breaks again
    await shelves.adopt(root)
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('never rejects, and keeps the cache when the library root itself has vanished (F3)', async () => {
    await shelves.create('To Read', ['a'])
    const cached = shelves.list()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(shelves.adopt(join(root, 'gone'))).resolves.toBeUndefined()
    expect(shelves.list()).toEqual(cached)
    expect(error).toHaveBeenCalled()
  })
})

describe('the gone-shelf predicate the REST surface reads (slice 5)', () => {
  it('recognises the writer own refusal, and nothing else', async () => {
    const shelf = await shelves.create('To Read')
    await shelves.deleteShelf(shelf.id)

    const err: unknown = await shelves.addBooks(shelf.id, ['a']).catch((e: unknown) => e)
    expect((err as Error).message).toBe(shelves.SHELF_GONE)
    expect(shelves.isShelfGone(err)).toBe(true)
    expect(shelves.isShelfGone(new Error('something else'))).toBe(false)
    expect(shelves.isShelfGone('not an error')).toBe(false)
  })
})
