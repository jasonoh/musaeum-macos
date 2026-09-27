import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualShelfEntry } from '@shared/shelf.types'
import { makeBook } from '../../../test/helpers/book'
import { deleteBook, deleteBooks, deleteFormats } from './book-delete'
import { readCatalog, writeCatalog } from './catalog'
import {
  closeDb,
  getBook,
  getBooks,
  getConflictQueue,
  insertBook,
  insertConflict,
  updateBook
} from './db'
import { subscribe } from './events'
import { list as listOverrides, markFromPatch } from './field-overrides'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as shelves from './shelves'
import { readShelvesFile, shelvesPath } from './shelves-file'

let root: string

/** A book on disk with one file per format, plus a cover and metadata.json. */
async function seed(id: string, formats: string[]): Promise<string> {
  const book = { ...makeBook(id), formats: formats as never }
  insertBook(book)
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  for (const f of formats) await fs.writeFile(join(dir, `Book ${id}.${f}`), f)
  await fs.writeFile(join(dir, 'cover_full.jpg'), 'jpg')
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, formats }))
  return dir
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-delete-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
})

afterEach(async () => {
  // Let any debounced catalog write land before the root disappears
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('deleteBook', () => {
  it('removes the folder, the cache row, and the catalog entry', async () => {
    const dir = await seed('a', ['epub'])
    librarySync.upsertCatalog([getBook('a')!])
    await librarySync.flushForTests()

    await deleteBook('a')
    await librarySync.flushForTests()

    await expect(fs.access(dir)).rejects.toThrow()
    expect(getBook('a')).toBeNull()
    expect((await readCatalog(root))?.books.map((b) => b.id)).toEqual([])
  })

  it('leaves no entry behind when the folder cannot be removed', async () => {
    // The row goes first, so a folder that will not go away costs a stray
    // folder rather than a book the app shows, cannot open, and cannot delete
    const dir = await seed('e', ['epub'])
    librarySync.upsertCatalog([getBook('e')!])
    await librarySync.flushForTests()
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('share dropped'))

    await deleteBook('e')
    rm.mockRestore()
    await librarySync.flushForTests()

    expect(getBook('e')).toBeNull()
    expect((await readCatalog(root))?.books.map((b) => b.id)).toEqual([])
    // The folder is still there — the honest cost of the ordering — and the
    // next delete of a re-imported copy would remove it
    expect((await fs.readdir(dir)).length).toBeGreaterThan(0)
  })
})

describe('deleteFormats', () => {
  it('deletes only the selected format files and keeps the book', async () => {
    const dir = await seed('b', ['epub', 'mobi', 'pdf'])

    const result = await deleteFormats('b', ['mobi'])
    await librarySync.flushForTests()

    expect(result).toEqual({ bookDeleted: false })
    expect((await fs.readdir(dir)).sort()).toEqual([
      'Book b.epub',
      'Book b.pdf',
      'cover_full.jpg',
      'metadata.json'
    ])
    expect(getBook('b')?.formats).toEqual(['epub', 'pdf'])
  })

  it('rewrites metadata.json and the catalog with the remaining formats', async () => {
    const dir = await seed('c', ['epub', 'azw3'])

    await deleteFormats('c', ['azw3'])
    await librarySync.flushForTests()

    const meta = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))
    expect(meta.formats).toEqual(['epub'])
    const cat = await readCatalog(root)
    expect(cat?.books.find((b) => b.id === 'c')?.formats).toEqual(['epub'])
  })

  it('deletes the whole book when every format is selected', async () => {
    const dir = await seed('d', ['epub', 'pdf'])

    const result = await deleteFormats('d', ['epub', 'pdf'])

    expect(result).toEqual({ bookDeleted: true })
    await expect(fs.access(dir)).rejects.toThrow()
    expect(getBooks()).toEqual([])
  })

  it('ignores formats the book does not have', async () => {
    await seed('e', ['epub', 'pdf'])

    const result = await deleteFormats('e', ['pdf', 'mobi'])

    expect(result).toEqual({ bookDeleted: false })
    expect(getBook('e')?.formats).toEqual(['epub'])
  })

  it('throws when nothing in the selection matches', async () => {
    await seed('f', ['epub'])
    await expect(deleteFormats('f', ['mobi'])).rejects.toThrow(/No matching formats/)
    expect(getBook('f')?.formats).toEqual(['epub'])
  })

  it('throws for an unknown book', async () => {
    await expect(deleteFormats('missing', ['epub'])).rejects.toThrow(/not found/)
  })

  it('recomputes file_size_bytes from the surviving format, not the stale stored value', async () => {
    const dir = await seed('g', ['epub', 'pdf'])
    // A *wrong* stored value, not an absent one: the point is that the write
    // replaces a stale number, not merely that it fills in a null (which an
    // implementation that only writes when the old value was missing would
    // also pass).
    updateBook('g', { fileSizeBytes: 999_999 })
    // seed() writes each format file's content as its own extension name, so
    // 'epub' (4 bytes) and 'pdf' (3 bytes) are unequal.

    await deleteFormats('g', ['pdf'])

    const survivor = await fs.stat(join(dir, 'Book g.epub'))
    expect(getBook('g')?.fileSizeBytes).toBe(survivor.size)
  })
})

describe('deleteBooks', () => {
  it('deletes every book, its folder, and its cache row', async () => {
    const dirs = [await seed('m1', ['epub']), await seed('m2', ['epub']), await seed('m3', ['pdf'])]
    await seed('keep', ['epub'])

    const result = await deleteBooks(['m1', 'm2', 'm3'])

    expect(result.deleted).toBe(3)
    expect(result.failed).toEqual([])
    for (const dir of dirs) {
      await expect(fs.access(dir)).rejects.toThrow()
    }
    expect(getBooks().map((b) => b.id)).toEqual(['keep'])
  })

  it('writes the catalog once for the whole batch, not once per book', async () => {
    await seed('m1', ['epub'])
    await seed('m2', ['epub'])
    await seed('m3', ['epub'])
    await seed('keep', ['epub'])
    const full = vi.spyOn(librarySync, 'writeFullCatalog')
    const perBook = vi.spyOn(librarySync, 'removeBookFromCatalog')

    await deleteBooks(['m1', 'm2', 'm3'])
    await librarySync.flushForTests()

    expect(full).toHaveBeenCalledTimes(1)
    expect(perBook).not.toHaveBeenCalled()
    // …and the file it wrote is correct, not merely written once
    const catalog = await readCatalog(root)
    expect(catalog?.books.map((b) => b.id)).toEqual(['keep'])
    full.mockRestore()
    perBook.mockRestore()
  })

  it('keeps going past a book it cannot delete, and reports it', async () => {
    await seed('ok1', ['epub'])
    await seed('ok2', ['epub'])

    // An id with no row is the cheapest stand-in for a book that has gone
    // missing under the batch — the point is that it doesn't abort the rest
    const result = await deleteBooks(['ok1', 'missing-entirely', 'ok2'])

    expect(result.deleted).toBe(2)
    expect(result.failed).toEqual([
      { id: 'missing-entirely', title: 'missing-entirely', error: 'Book not found' }
    ])
    expect(getBook('ok1')).toBeFalsy()
    expect(getBook('ok2')).toBeFalsy()
  })

  it('writes nothing when nothing was deleted', async () => {
    await seed('keep', ['epub'])
    const full = vi.spyOn(librarySync, 'writeFullCatalog')

    const result = await deleteBooks([])

    expect(result.deleted).toBe(0)
    expect(full).not.toHaveBeenCalled()
    full.mockRestore()
  })
})

/**
 * The review badge is a *number the renderer was told*, not something it reads:
 * only `conflictQueueUpdated` moves it, and only a restart re-reads the queue.
 * Deleting a book used to remove its conflicts from the database without
 * announcing the new count — the queue modal, which reads fresh, then said
 * "nothing needs attention" while the sidebar kept insisting on **4** until the
 * app was restarted. Reported 2026-09-20, and measured against the real
 * database afterwards: 42 conflict rows, all resolved, **zero** unresolved and
 * **zero** orphans, so the number on screen was never the database's.
 */
describe('the review count after a delete', () => {
  /** Every count the process announced while `run` was in flight. */
  async function announced(run: () => Promise<unknown>): Promise<number[]> {
    const counts: number[] = []
    const unsubscribe = subscribe((event, payload) => {
      if (event === 'conflictQueueUpdated') counts.push(payload as number)
    })
    try {
      await run()
    } finally {
      unsubscribe()
    }
    return counts
  }

  function conflictOn(id: string): void {
    insertConflict(id, 'author', [
      { source: 'embedded', value: 'Someone Else' },
      { source: 'google_books', value: 'Another Entirely' }
    ])
  }

  it('announces the count the queue will report, with a book deleted', async () => {
    await seed('c-del', ['epub'])
    conflictOn('c-del')
    expect(getConflictQueue()).toHaveLength(1)

    const counts = await announced(() => deleteBook('c-del'))

    // The number announced is the queue's own length, which is the whole point:
    // the badge and the modal cannot disagree
    expect(counts).toEqual([getConflictQueue().length])
    expect(counts).toEqual([0])
  })

  it('announces it once for a batch, not once per book', async () => {
    await seed('c-b1', ['epub'])
    await seed('c-b2', ['epub'])
    conflictOn('c-b1')
    conflictOn('c-b2')

    const counts = await announced(() => deleteBooks(['c-b1', 'c-b2']))

    expect(counts).toEqual([0])
  })

  it('announces zero when the deleted book had no conflicts', async () => {
    await seed('c-quiet', ['epub'])

    // Unconditional rather than conditional on the book having had conflicts:
    // one rule with no branch is one a future delete path cannot half-follow
    expect(await announced(() => deleteBook('c-quiet'))).toEqual([0])
  })

  it('takes the book’s field overrides with it', async () => {
    await seed('c-ov', ['epub'])
    seed('shared', ['epub'])
    markFromPatch('c-ov', { author: 'Melanie Mitchell' }, makeBook('c-ov'))
    markFromPatch('shared', { author: 'Someone Else' }, makeBook('shared'))
    expect(listOverrides('c-ov')).toEqual(['author'])

    await deleteBook('c-ov')

    // A dead id in the map is a field no fetch can ever be told about again —
    // the entry for the deleted book is the one that goes
    expect(listOverrides('c-ov')).toEqual([])
    expect(listOverrides('shared')).toEqual(['author'])
  })
})

describe('deleting a book takes it off every shelf (bookshelves D5)', () => {
  function countShelfWrites(): () => number {
    const spy = vi.spyOn(fs, 'writeFile')
    return () =>
      spy.mock.calls.filter(([path]) => String(path).endsWith('shelves.json.part')).length
  }

  async function membersOnDisk(): Promise<Record<string, string[]>> {
    const read = await readShelvesFile(root)
    if (read.state !== 'ok') throw new Error(`shelves.json is ${read.state}`)
    return Object.fromEntries(
      read.file.shelves.map((s) => [
        (s as ManualShelfEntry).name,
        (s as ManualShelfEntry).books.map((m) => m.id)
      ])
    )
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prunes a bulk delete from every shelf with one write (AC12)', async () => {
    for (const id of ['a', 'b', 'c']) await seed(id, ['epub'])
    const one = await shelves.create('One', ['a', 'b'])
    const two = await shelves.create('Two', ['b', 'c'])
    const writes = countShelfWrites()

    await deleteBooks(['a', 'b'])

    expect(writes()).toBe(1)
    expect(await membersOnDisk()).toEqual({ One: [], Two: ['c'] })
    expect(shelves.list()).toEqual([
      { id: one.id, name: 'One', kind: 'manual', count: 0 },
      { id: two.id, name: 'Two', kind: 'manual', count: 1 }
    ])
  })

  it('prunes a single delete the same way (AC12)', async () => {
    await seed('a', ['epub'])
    await seed('b', ['epub'])
    await shelves.create('One', ['a', 'b'])
    const writes = countShelfWrites()

    await deleteBook('a')

    expect(writes()).toBe(1)
    expect(await membersOnDisk()).toEqual({ One: ['b'] })
  })

  it('writes nothing for books on no shelf, and creates no shelves.json', async () => {
    await seed('a', ['epub'])
    await seed('b', ['epub'])
    const writes = countShelfWrites()

    await deleteBooks(['a'])
    await deleteBook('b')

    expect(writes()).toBe(0)
    await expect(fs.access(shelvesPath(root))).rejects.toThrow()
  })

  it('keeps the delete when the shelves cannot be pruned, and says the shelves changed', async () => {
    await seed('a', ['epub'])
    await shelves.create('One', ['a'])
    await fs.writeFile(shelvesPath(root), 'not json{', 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const events: string[] = []
    const unsubscribe = subscribe((event) => {
      events.push(event)
    })

    await expect(deleteBook('a')).resolves.toBeUndefined()
    unsubscribe()

    expect(getBook('a')).toBeNull()
    expect(shelves.list()[0].count).toBe(0)
    expect(error).toHaveBeenCalled()
    expect(events).toContain('shelvesChanged')
  })
})
