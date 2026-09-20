import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, ImportProgress, ImportResult } from '@shared/book.types'
import { makeBook } from '../../../test/helpers/book'
import { writeCatalog } from './catalog'
import { closeDb, getBook, getBooks, getConflictQueue, insertBook, updateBook } from './db'
import * as events from './events'
import {
  abortPendingDecisions,
  addFiles,
  hydrate,
  resolveDuplicate,
  writeMetadataJson
} from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'
import * as sidecar from './sidecar'

/**
 * Stubbed for the same reason as bulk-hydrate's suite: the real
 * `assertAvailable` starts a Python process, and here the fetch itself is what
 * is being scripted anyway.
 */
vi.mock('./sidecar', () => ({ call: vi.fn(), assertAvailable: vi.fn(), isAvailable: vi.fn() }))

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

/**
 * The collision the pre-copy gate cannot see. The gate reads the *file*, and a
 * file is frequently silent about its own identity — the real import that
 * produced two rows sharing ISBN 9781707274123 declared no identifiers at all
 * — so the ISBN a fetch settles is often the first one that could ever match,
 * and nothing used to look at it.
 *
 * Reported, never acted on: a shared ISBN is not proof of the same file (a
 * listing can copy a real book's ISBN), so the pair is a person's to judge.
 * See `docs/superpowers/specs/2026-09-20-post-hydration-duplicate-report-design.md`.
 */
describe('hydrate — the duplicate it reports', () => {
  const ISBN = '9781707274123'
  let root: string
  let dir: string

  beforeEach(async () => {
    closeDb()
    const userData = app.getPath('userData')
    for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
      rmSync(join(userData, f), { force: true })
    }
    librarySync.resetForTests()
    root = mkdtempSync(join(tmpdir(), 'musaeum-dup-'))
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

  it('names the other book when the ISBN the run settled is already held', async () => {
    insertBook({ ...makeBook('b', 'Summary of Fair Play'), isbn13: ISBN })
    // The fetch is what supplies the identity: this file carried none
    vi.mocked(sidecar.call).mockResolvedValue(reply({ identifiers: { isbn_13: ISBN } }))

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome.ok && outcome.duplicate).toEqual({
      existingBookId: 'b',
      existingTitle: 'Summary of Fair Play',
      existingAuthor: null,
      matchType: 'isbn'
    })
    // Reported, nothing acted on: both rows are exactly as they were
    expect(
      getBooks()
        .map((b) => b.id)
        .sort()
    ).toEqual(['a', 'b'])
    expect(getBook('b')?.isbn13).toBe(ISBN)
  })

  it('reports nothing when the settled ISBN is new to the library', async () => {
    vi.mocked(sidecar.call).mockResolvedValue(reply({ identifiers: { isbn_13: ISBN } }))

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.duplicate).toBeUndefined()
  })

  it('never reports the book as its own duplicate', async () => {
    updateBook('a', { isbn13: ISBN })
    vi.mocked(sidecar.call).mockResolvedValue(reply({ identifiers: { isbn_13: ISBN } }))

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir)

    expect(outcome.ok && outcome.duplicate).toBeUndefined()
  })

  it('says nothing when the pre-copy gate already named this collision', async () => {
    insertBook({ ...makeBook('b', 'Summary of Fair Play'), isbn13: ISBN })
    vi.mocked(sidecar.call).mockResolvedValue(reply({ identifiers: { isbn_13: ISBN } }))

    const outcome = await hydrate('a', join(dir, 'Book a.epub'), dir, undefined, {
      gateReported: true
    })

    expect(outcome.ok && outcome.duplicate).toBeUndefined()
  })
})

/**
 * The duplicate GATE (`docs/invariants/files-and-deletion.md` → "Duplicate
 * Detection"). An ISBN-13 match, else a normalized title+author match, pauses
 * `importOne` between the extract and the copy and waits for a decision keyed
 * by `jobId` — the watcher fans imports out concurrently, so the key is what
 * keeps two open gates apart. The three branches are not symmetric: only
 * `add_new` creates a book and hydrates; `add_format` writes into the matched
 * book's folder and hydrates nothing; `skip` leaves the library untouched.
 *
 * These tests drive the gate the way the app does: kick off `addFiles`, wait
 * for the `awaiting_dedup_decision` progress event to learn the jobId, then
 * answer it — which is also the only way to reach `importOne`, since it is not
 * exported.
 */
describe('the import duplicate gate', () => {
  let root: string
  let inbox: string
  /** Every importProgress payload broadcast during the test, in order. */
  let progress: ImportProgress[]

  /** The extraction reply (null = sidecar unavailable, so title comes from the filename). */
  function scriptSidecar(extracted: Record<string, unknown> | null): void {
    vi.mocked(sidecar.isAvailable).mockReturnValue(extracted !== null)
    vi.mocked(sidecar.call).mockImplementation(((method: string) =>
      Promise.resolve(
        method === 'hydrate_metadata' ? reply({ title: 'Dune' }) : (extracted ?? {})
      )) as typeof sidecar.call)
  }

  async function seed(book: Book): Promise<string> {
    insertBook(book)
    const dir = join(root, book.nasPath!)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /** Start an import and block until its gate is open; resolves to the jobId. */
  async function startImport(
    name: string
  ): Promise<{ settled: Promise<ImportResult[]>; jobId: string }> {
    const src = join(inbox, name)
    await fs.writeFile(src, 'ebook bytes')
    const settled = addFiles([src])
    const jobId = await vi.waitFor(() => {
      const gate = progress.find((p) => p.step === 'awaiting_dedup_decision')
      expect(gate).toBeDefined()
      return gate!.jobId
    })
    return { settled, jobId }
  }

  const PENDING = Symbol('pending')
  /** True while `p` has not settled — `p` is raced first so a settled one wins. */
  async function stillPending(p: Promise<unknown>): Promise<boolean> {
    await new Promise((r) => setImmediate(r))
    return (await Promise.race([p, Promise.resolve(PENDING)])) === PENDING
  }

  /** Wait for the async hydration `add_new` kicks off to finish emitting. */
  async function settleHydration(): Promise<void> {
    await vi.waitFor(() => expect(progress.map((p) => p.step)).toContain('done'))
  }

  beforeEach(async () => {
    closeDb()
    const userData = app.getPath('userData')
    for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
      rmSync(join(userData, f), { force: true })
    }
    librarySync.resetForTests()
    root = mkdtempSync(join(tmpdir(), 'musaeum-dedup-'))
    progress = []
    vi.spyOn(events, 'broadcast').mockImplementation((channel, payload) => {
      if (channel === 'importProgress') progress.push({ ...(payload as ImportProgress) })
    })
    await nas.setLibraryRoot(root)
    await writeCatalog(root, [])
    // setLibraryRoot's health check creates books/ imports/ exports/
    inbox = join(root, 'imports')
    scriptSidecar(null)
  })

  afterEach(async () => {
    // Any gate a failing test left open would otherwise hold a promise forever
    abortPendingDecisions()
    vi.restoreAllMocks()
    await librarySync.flushForTests()
    rmSync(root, { recursive: true, force: true })
  })

  describe('what opens the gate', () => {
    it('blocks on an ISBN-13 match even when title and author look unrelated', async () => {
      await seed({
        ...makeBook('existing', 'Dune'),
        author: 'Frank Herbert',
        isbn13: '9780441013593'
      })
      scriptSidecar({
        title: 'Melange: A Scan',
        authors: [{ name: 'Unknown Scanner' }],
        identifiers: { isbn_13: '9780441013593' }
      })

      const { settled, jobId } = await startImport('some-scan.epub')

      expect(progress.find((p) => p.step === 'awaiting_dedup_decision')?.duplicate).toEqual({
        existingBookId: 'existing',
        existingTitle: 'Dune',
        existingAuthor: 'Frank Herbert',
        matchType: 'isbn'
      })
      // The gate really blocks — nothing has been copied or inserted yet
      expect(await stillPending(settled)).toBe(true)
      expect(getBooks()).toHaveLength(1)
      expect(await fs.readdir(join(root, 'books'))).toEqual(['existing'])

      resolveDuplicate(jobId, { action: 'skip' })
      await settled
    })

    it('falls back to a normalized title+author match when nothing carries an ISBN', async () => {
      await seed(makeBook('existing', 'The Dispossessed'))
      // No sidecar, so the title is derived from the filename: underscores and
      // dots become spaces, and findByTitleAuthor normalizes case/punctuation
      const { settled, jobId } = await startImport('the_dispossessed.epub')

      expect(progress.find((p) => p.step === 'awaiting_dedup_decision')?.duplicate).toMatchObject({
        existingBookId: 'existing',
        matchType: 'title_author'
      })

      resolveDuplicate(jobId, { action: 'skip' })
      await settled
    })

    it('prefers the ISBN match when a different book also matches on title+author', async () => {
      await seed({
        ...makeBook('by-isbn', 'An Unrelated Title'),
        isbn13: '9780441013593'
      })
      await seed({ ...makeBook('by-title', 'Dune'), author: 'Frank Herbert' })
      scriptSidecar({
        title: 'Dune',
        authors: [{ name: 'Frank Herbert' }],
        identifiers: { isbn_13: '9780441013593' }
      })

      const { settled, jobId } = await startImport('dune.epub')

      // ISBN is checked first and wins; the title+author book is never consulted
      expect(progress.find((p) => p.step === 'awaiting_dedup_decision')?.duplicate).toMatchObject({
        existingBookId: 'by-isbn',
        matchType: 'isbn'
      })

      resolveDuplicate(jobId, { action: 'skip' })
      await settled
    })

    it('lets a non-duplicate straight through without a gate', async () => {
      await seed(makeBook('existing', 'A Different Book'))

      const src = join(inbox, 'Dune.epub')
      await fs.writeFile(src, 'ebook bytes')
      const [result] = await addFiles([src])

      expect(result.success).toBe(true)
      expect(progress.map((p) => p.step)).not.toContain('awaiting_dedup_decision')
      expect(getBooks()).toHaveLength(2)
      await settleHydration()
    })

    it('does not repeat a collision the gate already named (D5)', async () => {
      const ISBN = '9781707274123'
      await seed({ ...makeBook('existing', 'Fair Play'), isbn13: ISBN })
      // The file carries the ISBN the library already holds, so the gate fires
      // — and the hydration that follows settles the same one
      vi.mocked(sidecar.isAvailable).mockReturnValue(true)
      vi.mocked(sidecar.call).mockImplementation(((method: string) =>
        Promise.resolve(
          method === 'hydrate_metadata'
            ? reply({ title: 'Fair Play', identifiers: { isbn_13: ISBN } })
            : { identifiers: { isbn_13: ISBN } }
        )) as typeof sidecar.call)

      const { settled, jobId } = await startImport('Fair Play.epub')
      resolveDuplicate(jobId, { action: 'add_new' })
      await settled
      await settleHydration()

      // The gate's context dies with the decision it carried...
      expect(progress.find((p) => p.step === 'copying')?.duplicate).toBeUndefined()
      // ...so the finished card cannot present it as a post-hydration finding,
      // and the check itself stays quiet for the run the gate already covered
      expect(progress.filter((p) => p.step === 'done').at(-1)?.duplicate).toBeUndefined()
      expect(getBooks()).toHaveLength(2)
    })
  })

  describe('skip', () => {
    it('aborts the import: no book, no folder, and a result that says it was skipped', async () => {
      await seed(makeBook('existing', 'Dune'))
      const { settled, jobId } = await startImport('Dune.epub')

      resolveDuplicate(jobId, { action: 'skip' })
      const [result] = await settled

      expect(result).toEqual({
        jobId,
        fileName: 'Dune.epub',
        success: false,
        skipped: true,
        action: 'skip'
      })
      expect(getBooks()).toHaveLength(1)
      expect(await fs.readdir(join(root, 'books'))).toEqual(['existing'])
      expect(progress.at(-1)?.step).toBe('skipped')
    })

    it('leaves the matched book exactly as it was', async () => {
      const dir = await seed({ ...makeBook('existing', 'Dune'), formats: ['epub'] })
      const { settled, jobId } = await startImport('Dune.mobi')

      resolveDuplicate(jobId, { action: 'skip' })
      await settled

      expect(getBook('existing')?.formats).toEqual(['epub'])
      expect(await fs.readdir(dir)).toEqual([])
    })
  })

  describe('add_new', () => {
    it('creates a second book with its own id and folder, leaving the original alone', async () => {
      await seed({ ...makeBook('existing', 'Dune'), formats: ['epub'] })
      const { settled, jobId } = await startImport('Dune.epub')

      resolveDuplicate(jobId, { action: 'add_new' })
      const [result] = await settled
      await settleHydration()

      expect(result).toMatchObject({ jobId, fileName: 'Dune.epub', success: true })
      expect(result.bookId).not.toBe('existing')
      expect(getBooks()).toHaveLength(2)
      // Its own folder, named from the imported title
      expect(await fs.readdir(join(root, 'books', result.bookId!))).toEqual(
        expect.arrayContaining(['Dune.epub', 'metadata.json'])
      )
      // The matched book gained nothing
      expect(getBook('existing')?.formats).toEqual(['epub'])
      expect(await fs.readdir(join(root, 'books', 'existing'))).toEqual([])
    })

    it('runs the full pipeline, hydration included', async () => {
      await seed(makeBook('existing', 'Dune'))
      const { settled, jobId } = await startImport('Dune.epub')

      resolveDuplicate(jobId, { action: 'add_new' })
      const [result] = await settled
      await settleHydration()

      // add_new is the *unchanged* pipeline: copy, insert, then hydrate
      expect(progress.map((p) => p.step)).toEqual(
        expect.arrayContaining(['copying', 'hydrating', 'done'])
      )
      expect(sidecar.call).toHaveBeenCalledWith(
        'hydrate_metadata',
        expect.objectContaining({ book_id: result.bookId }),
        expect.any(Number)
      )
    })
  })

  describe('add_format', () => {
    it('adds the format to the matched book instead of creating a second one', async () => {
      const dir = await seed({ ...makeBook('existing', 'Dune'), formats: ['epub'] })
      const { settled, jobId } = await startImport('Dune.mobi')

      resolveDuplicate(jobId, { action: 'add_format' })
      const [result] = await settled

      expect(result).toEqual({
        jobId,
        fileName: 'Dune.mobi',
        success: true,
        bookId: 'existing',
        action: 'add_format'
      })
      expect(getBooks()).toHaveLength(1)
      expect(getBook('existing')?.formats).toEqual(['epub', 'mobi'])
      expect(await fs.readdir(join(root, 'books'))).toEqual(['existing'])
      // metadata.json is canonical, so the new format has to reach it
      const written = JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8')) as {
        formats: string[]
      }
      expect(written.formats).toEqual(['epub', 'mobi'])
    })

    it('names the copy after the existing book, not after the incoming file', async () => {
      const dir = await seed({
        ...makeBook('existing', 'Dune: Special Edition'),
        isbn13: '9780441013593'
      })
      // A PDF, so the sidecar extraction runs and can supply the matching ISBN
      scriptSidecar({ title: 'whatever', identifiers: { isbn_13: '9780441013593' } })
      const { settled, jobId } = await startImport('dune-import.pdf')

      resolveDuplicate(jobId, { action: 'add_format' })
      await settled

      // sanitizeTitle(existing.title) — the colon goes, the existing title stays
      expect(await fs.readdir(dir)).toContain('Dune Special Edition.pdf')
      expect(await fs.readdir(dir)).not.toContain('dune-import.pdf')
    })

    it('deletes every existing file of that extension first, so no stale copy survives', async () => {
      const dir = await seed({ ...makeBook('existing', 'Dune'), formats: ['epub', 'mobi'] })
      // A file left under an older title — findFormatFile picks by extension and
      // would choose between the two nondeterministically
      await fs.writeFile(join(dir, 'Old Mistaken Title.mobi'), 'stale')
      await fs.writeFile(join(dir, 'Dune.epub'), 'untouched')

      const { settled, jobId } = await startImport('Dune.mobi')
      resolveDuplicate(jobId, { action: 'add_format' })
      await settled

      const files = await fs.readdir(dir)
      expect(files.filter((f) => f.endsWith('.mobi'))).toEqual(['Dune.mobi'])
      expect(await fs.readFile(join(dir, 'Dune.mobi'), 'utf8')).toBe('ebook bytes')
      // Only the matching extension is cleared — the EPUB is not collateral
      expect(await fs.readFile(join(dir, 'Dune.epub'), 'utf8')).toBe('untouched')
    })

    it('does not add a duplicate entry when the book already has that format', async () => {
      await seed({ ...makeBook('existing', 'Dune'), formats: ['epub'] })
      const { settled, jobId } = await startImport('Dune.epub')

      resolveDuplicate(jobId, { action: 'add_format' })
      await settled

      expect(getBook('existing')?.formats).toEqual(['epub'])
    })

    it('never hydrates — the matched book keeps the metadata it already has', async () => {
      await seed({ ...makeBook('existing', 'Dune'), author: 'Frank Herbert' })
      const { settled, jobId } = await startImport('Dune.mobi')

      resolveDuplicate(jobId, { action: 'add_format' })
      await settled

      expect(sidecar.call).not.toHaveBeenCalledWith(
        'hydrate_metadata',
        expect.anything(),
        expect.anything()
      )
      expect(progress.map((p) => p.step)).not.toContain('hydrating')
      expect(progress.at(-1)).toMatchObject({ step: 'done', bookId: 'existing' })
      expect(getBook('existing')?.author).toBe('Frank Herbert')
    })
  })

  describe('resolveDuplicate', () => {
    it('ignores a jobId it has no gate for, rather than throwing', async () => {
      await seed(makeBook('existing', 'Dune'))
      const { settled, jobId } = await startImport('Dune.epub')

      expect(() => resolveDuplicate('not-a-real-job', { action: 'add_new' })).not.toThrow()
      // and the gate it was not addressed to is still waiting — the map is keyed
      // by jobId because the watcher fans imports out concurrently
      expect(await stillPending(settled)).toBe(true)

      resolveDuplicate(jobId, { action: 'skip' })
      expect((await settled)[0]).toMatchObject({ skipped: true })
    })

    it('ignores a second answer for a gate that has already been resolved', async () => {
      await seed(makeBook('existing', 'Dune'))
      const { settled, jobId } = await startImport('Dune.epub')

      resolveDuplicate(jobId, { action: 'skip' })
      await settled

      expect(() => resolveDuplicate(jobId, { action: 'add_new' })).not.toThrow()
      expect(getBooks()).toHaveLength(1)
    })

    it('keeps two concurrent gates apart', async () => {
      await seed(makeBook('one', 'Dune'))
      await seed(makeBook('two', 'Neuromancer'))

      const first = await startImport('Dune.epub')
      progress.length = 0 // so the next waitFor sees only the second gate
      const second = await startImport('Neuromancer.epub')

      resolveDuplicate(second.jobId, { action: 'skip' })
      expect((await second.settled)[0]).toMatchObject({
        fileName: 'Neuromancer.epub',
        skipped: true
      })
      expect(await stillPending(first.settled)).toBe(true)

      resolveDuplicate(first.jobId, { action: 'skip' })
      expect((await first.settled)[0]).toMatchObject({ fileName: 'Dune.epub', skipped: true })
    })
  })

  describe('abortPendingDecisions', () => {
    it('resolves every open gate as skip, so a quit never hangs on one', async () => {
      await seed(makeBook('one', 'Dune'))
      await seed(makeBook('two', 'Neuromancer'))
      const first = await startImport('Dune.epub')
      progress.length = 0
      const second = await startImport('Neuromancer.epub')

      abortPendingDecisions()

      // Both unwind, and neither leaves a book behind
      expect((await first.settled)[0]).toMatchObject({
        success: false,
        skipped: true,
        action: 'skip'
      })
      expect((await second.settled)[0]).toMatchObject({
        success: false,
        skipped: true,
        action: 'skip'
      })
      expect(getBooks()).toHaveLength(2)
      expect((await fs.readdir(join(root, 'books'))).sort()).toEqual(['one', 'two'])
    })

    it('is a no-op when nothing is waiting', () => {
      expect(() => abortPendingDecisions()).not.toThrow()
    })

    it('leaves no gate behind, so a later answer for the same job does nothing', async () => {
      await seed(makeBook('existing', 'Dune'))
      const { settled, jobId } = await startImport('Dune.epub')

      abortPendingDecisions()
      await settled

      expect(() => resolveDuplicate(jobId, { action: 'add_new' })).not.toThrow()
      expect(getBooks()).toHaveLength(1)
    })
  })
})
