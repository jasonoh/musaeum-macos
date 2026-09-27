import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualShelfEntry, ShelvesFile } from '@shared/shelf.types'
import { makeBook } from '../../../test/helpers/book'
import { closeDb, getBooks, insertBook } from './db'
import * as nas from './nas-manager'
import * as shelves from './shelves'
import { readShelvesFile, shelvesPath } from './shelves-file'

let root: string

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
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

/** Counts writes of shelves.json from here on — every write goes through its `.part`. */
function countWrites(): () => number {
  const spy = vi.spyOn(fs, 'writeFile')
  return () => spy.mock.calls.filter(([path]) => String(path).endsWith('shelves.json.part')).length
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
