import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { coverPreviews, resolveConflict } from './conflicts'
import { writeCatalog } from './catalog'
import { closeDb, getBook, getConflictQueue, insertBook, insertConflict, updateBook } from './db'
import { list } from './field-overrides'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/**
 * The sidecar is a Python process: an unmocked `call` would spawn one, and an
 * unmocked `assertAvailable` *starts* it (the same reason bulk-hydrate.test.ts
 * stubs it). Only `coverPreviews` reaches it today.
 */
vi.mock('./sidecar', () => ({ call: vi.fn(), assertAvailable: vi.fn() }))

let root: string

/** A book on disk with one epub file and a metadata.json, matching the seed
 * idiom in bulk-hydrate.test.ts / book-delete.test.ts. */
async function seed(id: string, title = `Book ${id}`): Promise<string> {
  insertBook(makeBook(id, title))
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `${title}.epub`), 'x')
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id, title }))
  return dir
}

/** The unresolved-conflict queue only ever holds what the test just inserted. */
function soleConflictId(): number {
  const queue = getConflictQueue()
  expect(queue).toHaveLength(1)
  return queue[0].id
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-conflicts-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
})

afterEach(async () => {
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('resolveConflict', () => {
  it('writes the chosen value to the correct Book column and marks the conflict resolved', async () => {
    await seed('a')
    insertConflict('a', 'publisher', [{ source: 'google_books', value: 'Orbit Books' }])
    const id = soleConflictId()

    await resolveConflict(id, { publisher: 'google_books' })

    expect(getBook('a')?.publisher).toBe('Orbit Books')
    expect(getConflictQueue()).toHaveLength(0)
  })

  it('records the resolved field as the user’s decision, so a re-fetch cannot undo it', async () => {
    // The incident behind this: an author resolved to "Eve Rodsky" came back as
    // "Ctprint" on the next fetch, because nothing told the merge that a person
    // had chosen (see the field-overrides design)
    await seed('a')
    insertConflict('a', 'author', [
      { source: 'embedded', value: 'Eve Rodsky' },
      { source: 'google_books', value: 'Ctprint' }
    ])
    const id = soleConflictId()

    await resolveConflict(id, { author: 'embedded' })

    expect(getBook('a')?.author).toBe('Eve Rodsky')
    expect(list('a')).toEqual(['author'])
  })

  it('throws when no choice was provided for the conflict field', async () => {
    await seed('a')
    insertConflict('a', 'author', [{ source: 'google_books', value: 'Ann Leckie' }])
    const id = soleConflictId()

    await expect(resolveConflict(id, {})).rejects.toThrow(/No choice provided/)
    expect(getBook('a')?.author).toBeNull()
  })

  it('throws when the chosen source is not a candidate for this conflict', async () => {
    await seed('a')
    insertConflict('a', 'author', [{ source: 'google_books', value: 'Ann Leckie' }])
    const id = soleConflictId()

    await expect(resolveConflict(id, { author: 'goodreads' })).rejects.toThrow(/not a candidate/)
    expect(getBook('a')?.author).toBeNull()
  })

  it('throws for a field with no known Book column', async () => {
    await seed('a')
    insertConflict('a', 'not_a_real_field', [{ source: 'google_books', value: 'x' }])
    const id = soleConflictId()

    await expect(resolveConflict(id, { not_a_real_field: 'google_books' })).rejects.toThrow(
      /Unknown conflict field/
    )
  })

  it('throws when the conflict id does not exist', async () => {
    await expect(resolveConflict(999, { title: 'google_books' })).rejects.toThrow(/Conflict not found/)
  })

  it('renames the book files to the resolved title — the third title-settling path', async () => {
    const dir = await seed('a', 'The Bakery Attack')
    insertConflict('a', 'title', [{ source: 'google_books', value: 'After the Quake' }])
    const id = soleConflictId()

    await resolveConflict(id, { title: 'google_books' })

    expect(getBook('a')?.title).toBe('After the Quake')
    const entries = await fs.readdir(dir)
    expect(entries).toContain('After the Quake.epub')
    expect(entries).not.toContain('The Bakery Attack.epub')
  })

  it('re-derives the sort title when a title conflict resolves (invariant 4)', async () => {
    await seed('a', 'The Bakery Attack')
    updateBook('a', { sortTitle: 'Bakery Attack, The' })
    insertConflict('a', 'title', [{ source: 'google_books', value: 'After the Quake' }])

    await resolveConflict(soleConflictId(), { title: 'google_books' })

    expect(getBook('a')?.sortTitle).toBe('After the Quake')
  })

  it('upserts the catalog and broadcasts unconditionally when online', async () => {
    await seed('a')
    insertConflict('a', 'publisher', [{ source: 'google_books', value: 'Orbit Books' }])
    const id = soleConflictId()
    const upsert = vi.spyOn(librarySync, 'upsertCatalog')

    await resolveConflict(id, { publisher: 'google_books' })

    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({ id: 'a', publisher: 'Orbit Books' })])
  })
})

describe('coverPreviews', () => {
  // A cover candidate is an image *URL* and the renderer's CSP names no remote
  // origin, so the queue's tiles used to render as two empty boxes — reported
  // from the app on 2026-09-21. The previews have to come from here, and the
  // boundary is the sidecar's: this is the wiring that says so.

  it('asks the sidecar for the candidates’ previews and hands its map back', async () => {
    const map = { 'https://example.test/a.jpg': 'data:image/jpeg;base64,AAAA' }
    vi.mocked(sidecar.call).mockResolvedValue(map)

    await expect(coverPreviews(['https://example.test/a.jpg'])).resolves.toEqual(map)

    expect(sidecar.call).toHaveBeenCalledWith(
      'cover_previews',
      { urls: ['https://example.test/a.jpg'] },
      60_000
    )
  })

  it('asks for nothing when there is nothing to show — no engine, no round trip', async () => {
    // The other half of "the previews are fetched": a conflict with no cover
    // candidates must not wake the sidecar at all, or the queue would need a
    // running metadata engine to render a *text* conflict
    vi.mocked(sidecar.call).mockClear()

    await expect(coverPreviews([])).resolves.toEqual({})

    expect(sidecar.call).not.toHaveBeenCalled()
  })
})
