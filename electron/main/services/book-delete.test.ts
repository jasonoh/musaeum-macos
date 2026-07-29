import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { deleteBook, deleteFormats } from './book-delete'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBook, getBooks, insertBook } from './db'
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
})
