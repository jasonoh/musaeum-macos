import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app, shell } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookFormat } from '@shared/book.types'
import { makeBook } from '../../../test/helpers/book'
import { writeCatalog } from './catalog'
import { closeDb, insertBook } from './db'
import { openBookFile, revealBook } from './file-access'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

/**
 * Where the formats[0] bug was measured live (1,372 of 7,100 books — see
 * test/invariants.test.ts): these pin invariants 2 and 3 behaviourally, at
 * the module that hands a book's files to the OS.
 */

const showItemInFolder = vi.fn()
const openPath = vi.fn()
Object.assign(shell, { showItemInFolder, openPath })

let root: string

async function seed(id: string, formats: BookFormat[], files: string[]): Promise<string> {
  insertBook({ ...makeBook(id), formats })
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  for (const f of files) await fs.writeFile(join(dir, f), 'x')
  return dir
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-file-access-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
  showItemInFolder.mockReset()
  openPath.mockReset().mockResolvedValue('')
})

afterEach(async () => {
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('revealBook', () => {
  it('reveals the preferred format, not whichever the array lists first', async () => {
    const dir = await seed('a', ['pdf', 'epub'], ['Renamed.PDF', 'Renamed.epub'])
    await revealBook('a')
    expect(showItemInFolder).toHaveBeenCalledWith(join(dir, 'Renamed.epub'))
  })

  it('opens the folder when no file matches any format', async () => {
    const dir = await seed('a', ['epub'], ['notes.txt'])
    await revealBook('a')
    expect(showItemInFolder).not.toHaveBeenCalled()
    expect(openPath).toHaveBeenCalledWith(dir)
  })

  it('rejects when the book folder is missing', async () => {
    insertBook(makeBook('a'))
    await expect(revealBook('a')).rejects.toThrow(/Book folder is missing/)
  })
})

describe('openBookFile', () => {
  it('finds a renamed file by extension, case-insensitively', async () => {
    const dir = await seed('a', ['epub'], ['Totally Different Name.EPUB'])
    await openBookFile('a', 'epub')
    expect(openPath).toHaveBeenCalledWith(join(dir, 'Totally Different Name.EPUB'))
  })

  it('rejects a format the folder does not hold', async () => {
    await seed('a', ['epub'], ['Book a.epub'])
    await expect(openBookFile('a', 'mobi')).rejects.toThrow(/No MOBI file/)
  })

  it('surfaces the OS error when opening fails', async () => {
    await seed('a', ['epub'], ['Book a.epub'])
    openPath.mockResolvedValue('no application')
    await expect(openBookFile('a', 'epub')).rejects.toThrow('no application')
  })
})
