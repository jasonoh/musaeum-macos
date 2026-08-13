import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { readCatalog, writeCatalog } from './catalog'
import { closeDb, getBook, insertBook } from './db'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import {
  flushPending,
  flushPendingBeforeQuit,
  nextReadStatus,
  resetForTests,
  saveProgress
} from './reading-state'

let root: string

async function seed(id: string, readStatus = 'unread' as const) {
  const book = { ...makeBook(id), readStatus }
  insertBook(book)
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id }))
  return dir
}

async function readJson(dir: string) {
  return JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))
}

beforeEach(async () => {
  closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  librarySync.resetForTests()
  resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-reading-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
})

afterEach(async () => {
  // Stop the health-check/reconnect timers the offline test can arm — left
  // running, a pending reconnect fires after teardown and shells out to
  // `open -g smb://...` on the real machine.
  nas.stopHealthChecks()
  // Let any fire-and-forget catalog upsert queued by a final report land
  // before the temp root is removed, so it can't race a later test's rmSync.
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('nextReadStatus', () => {
  it('starts a book reading on first progress', () => {
    expect(nextReadStatus('unread', 0.01)).toBe('reading')
  })

  it('finishes a book at 98%', () => {
    expect(nextReadStatus('reading', 0.98)).toBe('read')
  })

  it('never demotes a book already marked read', () => {
    // Manual override wins: reopening a finished book must not undo it
    expect(nextReadStatus('read', 0.05)).toBe('read')
  })
})

describe('saveProgress write tiering', () => {
  it('writes SQLite on every report but not the catalog', async () => {
    const dir = await seed('b1')
    await saveProgress({ bookId: 'b1', position: 'p1', percent: 0.1, final: false }, 1_000)

    expect(getBook('b1')?.readingState?.position).toBe('p1')
    await librarySync.flushForTests()
    expect((await readCatalog(root))?.books ?? []).toHaveLength(0)
    // First report is always past the interval, so metadata.json is written
    expect((await readJson(dir)).reading_state.position).toBe('p1')
  })

  it('does not rewrite metadata.json inside the throttle window', async () => {
    const dir = await seed('b2')
    await saveProgress({ bookId: 'b2', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b2', position: 'p2', percent: 0.2, final: false }, 6_000)

    expect(getBook('b2')?.readingState?.position).toBe('p2')
    expect((await readJson(dir)).reading_state.position).toBe('p1')
  })

  it('rewrites metadata.json once the throttle window passes', async () => {
    const dir = await seed('b3')
    await saveProgress({ bookId: 'b3', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b3', position: 'p2', percent: 0.2, final: false }, 40_000)

    expect((await readJson(dir)).reading_state.position).toBe('p2')
  })

  it('writes everything on a final report', async () => {
    const dir = await seed('b4')
    await saveProgress({ bookId: 'b4', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b4', position: 'p9', percent: 0.9, final: true }, 6_000)

    expect((await readJson(dir)).reading_state.position).toBe('p9')
    await librarySync.flushForTests()
    const catalogued = (await readCatalog(root))?.books.find((b) => b.id === 'b4')
    expect(catalogued?.readingState?.position).toBe('p9')
  })

  it('advances read status as progress is saved', async () => {
    await seed('b5')
    await saveProgress({ bookId: 'b5', position: 'p1', percent: 0.1, final: false }, 1_000)
    expect(getBook('b5')?.readStatus).toBe('reading')

    await saveProgress({ bookId: 'b5', position: 'p2', percent: 0.99, final: true }, 40_000)
    expect(getBook('b5')?.readStatus).toBe('read')
  })

  it('clamps a percent outside 0-1', async () => {
    await seed('b6')
    await saveProgress({ bookId: 'b6', position: 'p1', percent: 1.5, final: false }, 1_000)
    expect(getBook('b6')?.readingState?.percent).toBe(1)
  })

  it('ignores a report for a book that no longer exists', async () => {
    await expect(
      saveProgress({ bookId: 'ghost', position: 'p1', percent: 0.1, final: false }, 1_000)
    ).resolves.toBeUndefined()
  })
})

describe('offline', () => {
  it('keeps recording position without touching the NAS', async () => {
    const dir = await seed('b7')
    // `nas.setLibraryRoot` only accepts a string path (verified against
    // nas-manager.ts), so offline is reached by pointing the root at a
    // directory that doesn't exist: checkHealth() fails isMounted() and
    // settles into 'disconnected', which is what saveProgress actually
    // branches on (nas.isOnline()) rather than the root itself.
    await nas.setLibraryRoot(join(root, 'does-not-exist'))
    // Prove the precondition actually holds — without this, a broken
    // setLibraryRoot substitution could silently leave the suite "online"
    // and the assertions below would pass for the wrong reason.
    expect(nas.isOnline()).toBe(false)

    // Distinguishes "write skipped" from "write attempted and failed silently
    // the same way": saveProgress's only failure path for writeMetadataJson
    // logs via console.warn (`[reading] could not write metadata.json...`).
    // If the `!nas.isOnline()` guard were removed, the code would still reach
    // an unwritable path, but it would ATTEMPT the write, hit ENOENT, and
    // warn — so asserting the warn was never called catches that regression
    // even though the other two assertions below would still hold either way.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await saveProgress({ bookId: 'b7', position: 'p1', percent: 0.3, final: false }, 1_000)

      // Reading is not interrupted by a dropped share
      expect(getBook('b7')?.readingState?.position).toBe('p1')
      expect((await readJson(dir)).reading_state).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('flushPending', () => {
  it('writes an unsaved position at quit', async () => {
    const dir = await seed('b8')
    await saveProgress({ bookId: 'b8', position: 'p1', percent: 0.1, final: false }, 1_000)
    await saveProgress({ bookId: 'b8', position: 'p2', percent: 0.2, final: false }, 6_000)

    await flushPending()

    expect((await readJson(dir)).reading_state.position).toBe('p2')
    await librarySync.flushForTests()
    const catalogued = (await readCatalog(root))?.books.find((b) => b.id === 'b8')
    expect(catalogued?.readingState?.position).toBe('p2')
  })

  it('does nothing when every book was already flushed', async () => {
    await seed('b9')
    await saveProgress({ bookId: 'b9', position: 'p1', percent: 0.1, final: true }, 1_000)
    await expect(flushPending()).resolves.toBeUndefined()
  })
})

describe('flushPendingBeforeQuit', () => {
  it('resolves once the flush completes, well inside the timeout', async () => {
    await expect(flushPendingBeforeQuit(1_000, () => Promise.resolve())).resolves.toBeUndefined()
  })

  it('does not wait for a stalled flush — quit is never blocked by a dead NAS write', async () => {
    const hangingFlush = () => new Promise<void>(() => undefined) // never settles
    const start = Date.now()
    await flushPendingBeforeQuit(30, hangingFlush)
    // Generous slack for CI scheduling jitter; a real hang would be >>100ms late.
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('propagates a flush rejection rather than hanging or swallowing it', async () => {
    const failingFlush = () => Promise.reject(new Error('nas write failed'))
    await expect(flushPendingBeforeQuit(1_000, failingFlush)).rejects.toThrow('nas write failed')
  })
})
