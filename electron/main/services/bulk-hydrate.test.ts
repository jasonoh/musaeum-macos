import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BulkHydrateProgress } from '@shared/metadata.types'
import { makeBook } from '../../../test/helpers/book'
import * as sidecar from './sidecar'
import { writeCatalog } from './catalog'
import { closeDb, insertBook } from './db'
import * as events from './events'
import * as importer from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import {
  cancelBulkHydrate,
  findHydratableFile,
  flushForTests,
  resetForTests,
  startBulkHydrate
} from './bulk-hydrate'

/**
 * Stubbed because the real `assertAvailable` *starts* the sidecar, and
 * `getAppPath()` is the repo root under vitest — so an unmocked guard spawns a
 * live Python process against `sidecar/.venv` for every test in this file.
 */
vi.mock('./sidecar', () => ({ assertAvailable: vi.fn() }))

let root: string
/** Order and overlap of hydrate calls, for the sequencing assertions. */
let calls: { id: string; start: number; end: number }[]

async function seed(id: string, ext = 'epub'): Promise<void> {
  insertBook(makeBook(id))
  const dir = join(root, `books/${id}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, `Book ${id}.${ext}`), 'x')
}

beforeEach(async () => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  librarySync.resetForTests()
  resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-bulk-hydrate-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])

  calls = []
  vi.spyOn(importer, 'hydrate').mockImplementation(async (bookId) => {
    const start = Date.now()
    await new Promise((r) => setTimeout(r, 10))
    calls.push({ id: bookId, start, end: Date.now() })
    // A book that hydrates cleanly and finds nothing new — the common case
    return { ok: true, changed: [], conflicts: 0 }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('findHydratableFile', () => {
  it('finds an epub, mobi or azw3 and ignores a pdf', async () => {
    await seed('a', 'epub')
    await seed('b', 'azw3')
    await seed('c', 'pdf')
    expect(await findHydratableFile(join(root, 'books/a'))).toContain('.epub')
    expect(await findHydratableFile(join(root, 'books/b'))).toContain('.azw3')
    expect(await findHydratableFile(join(root, 'books/c'))).toBeNull()
  })

  it('reads the folder in preference order, not readdir order', async () => {
    // Written azw3-first in both cases, so a plain `find` over the listing
    // would pick the azw3 and the `.mobi` respectively. The sidecar extracts
    // embedded metadata from an EPUB and nothing else, so picking by
    // `readdir` order (which is directory order, not sorted) silently drops a
    // book's embedded identifiers, its cover fallback and the description
    // `longest wins` would otherwise have preferred.
    await seed('d', 'azw3')
    await fs.writeFile(join(root, 'books/d/Book d.epub'), 'x')
    expect(await findHydratableFile(join(root, 'books/d'))).toContain('.epub')

    await seed('e', 'mobi')
    await fs.writeFile(join(root, 'books/e/Book e.azw3'), 'x')
    expect(await findHydratableFile(join(root, 'books/e'))).toContain('.azw3')
  })
})

describe('startBulkHydrate', () => {
  it('hydrates books one at a time, never concurrently', async () => {
    await seed('a')
    await seed('b')
    await seed('c')

    startBulkHydrate(['a', 'b', 'c'])
    await flushForTests()

    expect(calls.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    // No call may begin before its predecessor ended — this is the rate-limit
    // guarantee, and the reason the loop awaits rather than fanning out
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].start).toBeGreaterThanOrEqual(calls[i - 1].end)
    }
  })

  it('passes batched: true so hydrate does not write the catalog per book', async () => {
    await seed('a')
    startBulkHydrate(['a'])
    await flushForTests()

    expect(importer.hydrate).toHaveBeenCalledWith(
      'a',
      expect.stringContaining('Book a.epub'),
      join(root, 'books/a'),
      undefined,
      { batched: true }
    )
  })

  it('writes the catalog once for the whole job', async () => {
    await seed('a')
    await seed('b')
    const full = vi.spyOn(librarySync, 'writeFullCatalog')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    expect(full).toHaveBeenCalledTimes(1)
  })

  it('skips a book with no hydratable file rather than failing', async () => {
    await seed('a', 'pdf')
    await seed('b')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    expect(calls.map((c) => c.id)).toEqual(['b'])
  })

  it('refuses to start a second job while one is running', async () => {
    await seed('a')
    startBulkHydrate(['a'])
    expect(() => startBulkHydrate(['a'])).toThrow(/already running/i)
    await flushForTests()
  })

  it('stops early when cancelled', async () => {
    await seed('a')
    await seed('b')
    await seed('c')

    startBulkHydrate(['a', 'b', 'c'])
    cancelBulkHydrate()
    await flushForTests()

    // The in-flight book finishes — a sidecar call can't be torn off midway —
    // but nothing after it starts
    expect(calls.length).toBeLessThan(3)
  })

  it('stops when the NAS goes offline mid-job', async () => {
    await seed('a')
    await seed('b')
    await seed('c')
    vi.spyOn(nas, 'isOnline').mockReturnValue(false)

    startBulkHydrate(['a', 'b', 'c'])
    await flushForTests()

    expect(calls).toEqual([])
  })

  it('throws when the NAS is offline before it starts', async () => {
    vi.spyOn(nas, 'assertOnline').mockImplementation(() => {
      throw new Error('Library is offline')
    })
    expect(() => startBulkHydrate(['a'])).toThrow(/offline/i)
  })

  // Without this the job starts, reports every book as a bare failure, and
  // gives no hint that the cause is one missing interpreter rather than the
  // books themselves
  it('throws when the sidecar has no interpreter, before hydrating anything', async () => {
    await seed('a')
    vi.mocked(sidecar.assertAvailable).mockImplementation(() => {
      throw new Error('Python sidecar is unavailable')
    })

    expect(() => startBulkHydrate(['a'])).toThrow(/sidecar is unavailable/i)
    await flushForTests()
    expect(calls).toEqual([])
  })
})

/**
 * The job's only report. `hydrate` returns its failure instead of throwing, so
 * without these assertions a book that never made it looks exactly like a book
 * that was already up to date.
 */
describe('bulk hydrate reporting', () => {
  function lastProgress(spy: ReturnType<typeof vi.spyOn>): BulkHydrateProgress {
    const sent = spy.mock.calls
      .filter(([channel]) => channel === 'bulkHydrateProgress')
      .map(([, payload]) => payload as BulkHydrateProgress)
    return sent[sent.length - 1]
  }

  it('counts a failed hydration as failed, with its reason', async () => {
    await seed('a')
    await seed('b')
    vi.mocked(importer.hydrate).mockImplementation(async (id) =>
      id === 'b'
        ? { ok: false, error: 'Python sidecar is unavailable' }
        : { ok: true, changed: [], conflicts: 0 }
    )
    const spy = vi.spyOn(events, 'broadcast')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    const progress = lastProgress(spy)
    expect(progress).toMatchObject({
      completed: 2,
      failed: 1,
      updated: 0,
      lastError: 'Python sidecar is unavailable',
      running: false
    })
  })

  it('counts only the books whose metadata actually changed', async () => {
    await seed('a')
    await seed('b')
    vi.mocked(importer.hydrate).mockImplementation(async (id) => ({
      ok: true,
      changed: id === 'a' ? ['cover', 'series'] : [],
      conflicts: 0
    }))
    const spy = vi.spyOn(events, 'broadcast')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    expect(lastProgress(spy)).toMatchObject({ completed: 2, updated: 1, running: false })
  })

  it('says the run was cancelled rather than leaving a count that stopped', async () => {
    await seed('a')
    await seed('b')
    const spy = vi.spyOn(events, 'broadcast')

    startBulkHydrate(['a', 'b'])
    cancelBulkHydrate()
    await flushForTests()

    expect(lastProgress(spy)).toMatchObject({ stopped: 'cancelled', running: false })
  })

  it('names the share dropping as the reason it stopped', async () => {
    await seed('a')
    await seed('b')
    // Online for the first book's check, gone for the second's
    vi.spyOn(nas, 'isOnline').mockReturnValueOnce(true).mockReturnValue(false)
    const spy = vi.spyOn(events, 'broadcast')

    startBulkHydrate(['a', 'b'])
    await flushForTests()

    const progress = lastProgress(spy)
    expect(progress).toMatchObject({ completed: 1, stopped: 'offline', running: false })
  })
})
