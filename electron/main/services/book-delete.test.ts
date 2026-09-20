import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { deleteBook, deleteBooks, deleteFormats } from './book-delete'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBook, getBooks, insertBook, updateBook } from './db'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

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
