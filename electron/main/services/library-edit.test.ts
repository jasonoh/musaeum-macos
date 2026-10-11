import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBook, insertBook, setOwnedFields } from './db'
import { list } from './field-overrides'
import { writeMetadataJson } from './importer'
import { releaseFieldOverride, updateBook } from './library-edit'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

vi.mock('./sidecar', () => ({ call: vi.fn(), assertAvailable: vi.fn() }))

let root: string

/** A book on disk with one epub and a metadata.json — conflicts.test.ts's seed. */
async function seed(id: string, title = `Book ${id}`): Promise<string> {
  insertBook(makeBook(id, title))
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `${title}.epub`), 'x')
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, title }))
  return dir
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-library-edit-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('updateBook (the metadata editor save)', () => {
  it('writes the row and metadata.json, then renames the files to the new title', async () => {
    const dir = await seed('a', 'Old Title')

    await updateBook('a', { title: 'New Title' })

    expect(getBook('a')?.title).toBe('New Title')
    expect(JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')).title).toBe(
      'New Title'
    )
    const entries = await fs.readdir(dir)
    expect(entries).toContain('New Title.epub')
    expect(entries).not.toContain('Old Title.epub')
  })

  it('marks the fields the patch changed as the user’s decision', async () => {
    await seed('a')
    await updateBook('a', { publisher: 'Knopf' })
    expect(list('a')).toContain('publisher')
  })

  it('refuses while the library is offline, writing nothing', async () => {
    await seed('a', 'Old Title')
    vi.spyOn(nas, 'assertOnline').mockImplementation(() => {
      throw new Error('offline')
    })

    await expect(updateBook('a', { title: 'X' })).rejects.toThrow('offline')
    expect(getBook('a')?.title).toBe('Old Title')
  })
})

describe('releaseFieldOverride', () => {
  const CLAIM = '2026-10-11T10:00:00.000Z'

  it('drops the claim from the row, the record and the catalog', async () => {
    const dir = await seed('a')
    // The row, the record and the catalog all hold the claim, as after an edit
    setOwnedFields('a', { author: CLAIM })
    await writeMetadataJson(dir, getBook('a')!)
    await writeCatalog(root, [getBook('a')!])
    expect(JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))).toHaveProperty(
      'owned_fields'
    )
    await expect(releaseFieldOverride('a', 'author')).resolves.toEqual([])

    expect(getBook('a')!.ownedFields).toEqual({})
    expect(JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))).not.toHaveProperty(
      'owned_fields'
    )
    await librarySync.flushForTests()
    expect((await readCatalog(root))!.books.find((b) => b.id === 'a')!.ownedFields).toEqual({})
  })

  it('refuses offline, so a release is never re-imposed by the next adoption', async () => {
    await seed('a')
    setOwnedFields('a', { author: CLAIM })
    vi.spyOn(nas, 'assertOnline').mockImplementation(() => {
      throw new Error('offline')
    })

    await expect(releaseFieldOverride('a', 'author')).rejects.toThrow('offline')
    expect(getBook('a')!.ownedFields).toEqual({ author: CLAIM })
  })
})
