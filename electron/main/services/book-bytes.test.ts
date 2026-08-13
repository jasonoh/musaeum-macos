import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { resolveBookFile } from './book-bytes'
import { closeDb, insertBook } from './db'
import * as nas from './nas-manager'

let root: string

beforeEach(async () => {
  closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  root = mkdtempSync(join(tmpdir(), 'musaeum-bytes-'))
  await nas.setLibraryRoot(root)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function seed(id: string, fileName: string) {
  insertBook(makeBook(id))
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, fileName), 'bytes')
  return join(dir, fileName)
}

describe('resolveBookFile', () => {
  it('finds the file for a format', async () => {
    const path = await seed('b1', 'Leviathan Wakes.epub')
    expect(await resolveBookFile('b1', 'epub')).toBe(path)
  })

  it('matches by extension, so a renamed book still opens', async () => {
    // Files are named from the title at import; the title moves afterwards
    const path = await seed('b2', 'Some Older Title.epub')
    expect(await resolveBookFile('b2', 'epub')).toBe(path)
  })

  it('returns null when the book has no file of that format', async () => {
    await seed('b3', 'Book.epub')
    expect(await resolveBookFile('b3', 'mobi')).toBeNull()
  })

  it('rejects a format outside the union', async () => {
    await seed('b4', 'Book.epub')
    expect(await resolveBookFile('b4', 'sh')).toBeNull()
    expect(await resolveBookFile('b4', '../../etc/passwd')).toBeNull()
  })

  it('returns null for an unknown book', async () => {
    expect(await resolveBookFile('nope', 'epub')).toBeNull()
  })

  it('returns null when the book folder is missing', async () => {
    insertBook(makeBook('b5'))
    expect(await resolveBookFile('b5', 'epub')).toBeNull()
  })

  it('refuses a book whose nasPath escapes the library root', async () => {
    const book = { ...makeBook('b6'), nasPath: '../outside' }
    insertBook(book)
    expect(await resolveBookFile('b6', 'epub')).toBeNull()
  })

  it('refuses a symlinked file that points outside the library root', async () => {
    const outside = join(tmpdir(), `musaeum-bytes-outside-${Date.now()}`)
    await fs.writeFile(outside, 'secret')
    try {
      insertBook(makeBook('b7'))
      const dir = join(root, 'books', 'b7')
      await fs.mkdir(dir, { recursive: true })
      await fs.symlink(outside, join(dir, 'Book.epub'))
      expect(await resolveBookFile('b7', 'epub')).toBeNull()
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('resolves normally when the library root itself is reached through a symlink', async () => {
    const target = mkdtempSync(join(tmpdir(), 'musaeum-bytes-target-'))
    const link = join(tmpdir(), `musaeum-bytes-link-${Date.now()}`)
    await fs.symlink(target, link)
    await nas.setLibraryRoot(link)
    try {
      insertBook(makeBook('b8'))
      const dir = join(link, 'books', 'b8')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'Book.epub'), 'bytes')
      expect(await resolveBookFile('b8', 'epub')).toBe(join(dir, 'Book.epub'))
    } finally {
      await fs.rm(link, { force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})
