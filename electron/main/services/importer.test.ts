import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { writeCatalog } from './catalog'
import { closeDb, getBook, getConflictQueue, insertBook, updateBook } from './db'
import { hydrate, writeMetadataJson } from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/**
 * Stubbed for the same reason as bulk-hydrate's suite: the real
 * `assertAvailable` starts a Python process, and here the fetch itself is what
 * is being scripted anyway.
 */
vi.mock('./sidecar', () => ({ call: vi.fn(), assertAvailable: vi.fn() }))

let bookDir: string
beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'musaeum-importer-'))
})
afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true })
})

describe('writeMetadataJson', () => {
  it('leaves no .part file behind after writing', async () => {
    await writeMetadataJson(bookDir, makeBook('a'))
    const leftovers = (await fs.readdir(bookDir)).filter((f) => f.includes('.part'))
    expect(leftovers).toEqual([])
  })

  // Regression test for a real interleaving: reader:saveProgress is
  // unserialized and updates its "already wrote this book" bookkeeping only
  // after the await, so a session's first two page turns can both start a
  // writeMetadataJson call for the same book folder concurrently. Both must
  // complete without throwing, the file left behind must be valid JSON
  // matching one writer's payload (not a torn interleaving of both), and no
  // scratch file may remain. This is discriminating against a fixed scratch
  // name: with a shared `${target}.part`, one writer's rename can race the
  // other's write, and this test fails (either an ENOENT from the losing
  // rename or a torn/invalid metadata.json).
  it('completes both writers and leaves a valid, uncorrupted file when two concurrent writes target the same folder', async () => {
    const bookA = makeBook('a', 'Title From Writer A')
    const bookB = makeBook('a', 'Title From Writer B')

    await Promise.all([writeMetadataJson(bookDir, bookA), writeMetadataJson(bookDir, bookB)])

    const raw = await fs.readFile(join(bookDir, 'metadata.json'), 'utf8')
    const parsed = JSON.parse(raw) as { title: string }
    expect(['Title From Writer A', 'Title From Writer B']).toContain(parsed.title)

    const leftovers = (await fs.readdir(bookDir)).filter((f) => f.includes('.part'))
    expect(leftovers).toEqual([])
  })
})

/** The subset of the sidecar's hydrate_metadata reply this suite scripts. */
interface HydrationReply {
  metadata: Record<string, unknown>
  conflicts: { field: string; candidates: { source: string; value: string }[] }[]
  cover: {
    full: string
    thumb: string
    source: string
    width: number
    height: number
    changed?: boolean
  } | null
}

function reply(
  metadata: Record<string, unknown> = {},
  cover: HydrationReply['cover'] = null
): HydrationReply {
  return { metadata, conflicts: [], cover }
}

const COVER = {
  full: 'cover_full.jpg',
  thumb: 'cover_thumb.jpg',
  source: 'google_books',
  width: 800,
  height: 1200
}

/**
 * `hydrate` reports what it did, because an explicit re-fetch has a user
 * waiting on the answer. The interesting half is what it does *not* report:
 * a field the fetch merely restated must not read as an update.
 */
describe('hydrate — the outcome it reports', () => {
  let root: string
  let dir: string

  beforeEach(async () => {
    closeDb()
    const userData = app.getPath('userData')
    for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
      rmSync(join(userData, f), { force: true })
    }
    librarySync.resetForTests()
    root = mkdtempSync(join(tmpdir(), 'musaeum-hydrate-'))
    await nas.setLibraryRoot(root)
    await writeCatalog(root, [])
    dir = join(root, 'books/a')
    await fs.mkdir(dir, { recursive: true })
    insertBook(makeBook('a'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await librarySync.flushForTests()
    rmSync(root, { recursive: true, force: true })
  })

  it('names the fields the fetch really changed', async () => {
    vi.mocked(sidecar.call).mockResolvedValue(
      reply({
        title: 'Dune',
        authors: [{ name: 'Frank Herbert' }],
        series: { name: 'Dune', index: 1, total: 6 }
      })
    )

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome).toEqual({ ok: true, changed: ['title', 'author', 'series'], conflicts: 0 })
    expect(getBook('a')?.author).toBe('Frank Herbert')
    // The canonical record is still written on the way through
    const written = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as {
      title: string
    }
    expect(written.title).toBe('Dune')
  })

  it('reports nothing at all when the sources agree with the book', async () => {
    vi.mocked(sidecar.call).mockResolvedValue(reply({ title: 'Book a' }))

    // The row has no sort_title, so this run backfills one — derived, and not
    // a change to what the user calls the title
    expect(await hydrate('a', join(dir, 'Book a.epub'), dir)).toEqual({
      ok: true,
      changed: [],
      conflicts: 0
    })
    expect(getBook('a')?.sortTitle).toBe('Book a')
  })

  it('reports the cover only when the artwork actually differs', async () => {
    updateBook('a', { coverFullPath: 'cover_full.jpg', coverThumbPath: 'cover_thumb.jpg' })
    vi.mocked(sidecar.call).mockResolvedValue(reply({}, { ...COVER, changed: false }))

    // The paths are fixed names, so only the sidecar's byte comparison can
    // tell a re-download of the same art from a new one
    expect(await hydrate('a', join(dir, 'Book a.epub'), dir)).toEqual({
      ok: true,
      changed: [],
      conflicts: 0
    })
  })

  it('reports the cover when the sidecar says the bytes differ', async () => {
    updateBook('a', { coverFullPath: 'cover_full.jpg', coverThumbPath: 'cover_thumb.jpg' })
    vi.mocked(sidecar.call).mockResolvedValue(reply({}, { ...COVER, changed: true }))

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome).toEqual({ ok: true, changed: ['cover'], conflicts: 0 })
  })

  it('treats a book that had no cover as changed even without the flag', async () => {
    vi.mocked(sidecar.call).mockResolvedValue(reply({}, COVER))

    expect(await hydrate('a', join(dir, 'Book a.epub'), dir)).toEqual({
      ok: true,
      changed: ['cover'],
      conflicts: 0
    })
  })

  it('counts the conflicts it queued', async () => {
    vi.mocked(sidecar.call).mockResolvedValue({
      ...reply({ title: 'Dune' }),
      conflicts: [
        {
          field: 'title',
          candidates: [
            { source: 'google_books', value: 'Dune' },
            { source: 'openlibrary', value: 'Dune Messiah' }
          ]
        }
      ]
    })

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome).toMatchObject({ ok: true, conflicts: 1 })
    expect(getConflictQueue()).toHaveLength(1)
  })

  it('returns a failure rather than throwing, so import stays non-fatal', async () => {
    vi.mocked(sidecar.call).mockRejectedValue(
      new Error('Sidecar call hydrate_metadata timed out after 300000ms')
    )

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome).toEqual({
      ok: false,
      error: 'Sidecar call hydrate_metadata timed out after 300000ms'
    })
    expect(getBook('a')?.title).toBe('Book a')
  })
})
