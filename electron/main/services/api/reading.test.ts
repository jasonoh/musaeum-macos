import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ReadStatus } from '@shared/book.types'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../../test/helpers/book'
import { readCatalog, writeCatalog } from '../catalog'
import * as db from '../db'
import { subscribe } from '../events'
import * as librarySync from '../library-sync'
import * as nas from '../nas-manager'
import { flushPending, nextReadStatus, resetForTests } from '../reading-state'
import { applyReadingReport, parseReadingReport } from './reading'

/**
 * The one write (slice 1c of the iOS companion): AC20–AC24.
 *
 * Everything here is decided against the row and the files on disk rather than
 * against what the module says it did, because the interesting claims are all
 * about *side effects*: the fraction reached SQLite and the position did not,
 * a stale report left the row byte-identical, the status advanced by
 * `nextReadStatus` and nothing else, and an offline share still got the report
 * — parked, not dropped.
 *
 * Hermetic by construction, like `reading-state.test.ts` beside it: the
 * `electron` alias gives every worker a throwaway `userData`, and the library
 * root is a temp directory this file creates and removes. The real profile and
 * the real library are never touched — this is the one module in the API that
 * writes, so that matters twice over.
 *
 * AC25/AC26 are **not** here and cannot be: they are about where the real
 * foliate engine opens a book, and only a CDP probe in the running app can
 * decide them (see the slice's report).
 */

let root: string

/** The book's folder with a `metadata.json` already in it, as a real library has. */
async function seed(id: string, readStatus: ReadStatus = 'unread'): Promise<string> {
  db.insertBook({ ...makeBook(id), readStatus })
  const dir = join(root, 'books', id)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(join(dir, 'metadata.json'), JSON.stringify({ id }))
  return dir
}

async function readJson(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(join(dir, 'metadata.json'), 'utf8'))
}

/** The row as the database holds it — the columns, before any mapping. */
function rawRow(id: string): Record<string, unknown> {
  return db.getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown>
}

const OLD = '2026-01-01T00:00:00.000Z'

beforeEach(async () => {
  db.closeDb()
  const userData = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(userData, f), { force: true })
  }
  librarySync.resetForTests()
  resetForTests()
  root = mkdtempSync(join(tmpdir(), 'musaeum-reading-api-'))
  await nas.setLibraryRoot(root)
  await writeCatalog(root, [])
})

afterEach(async () => {
  // The health-check timers the offline case arms shell out to `open -g smb://…`
  // on the real machine if they are left running, and a fire-and-forget catalog
  // write must land before the temp root goes away
  nas.stopHealthChecks()
  await librarySync.flushForTests()
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// AC20 — the fraction lands, the position does not
// ---------------------------------------------------------------------------

describe('a report writes the fraction and blanks the position (AC20)', () => {
  it('writes reading_percent, moves the clock, and leaves reading_position null', async () => {
    await seed('a1')

    const before = rawRow('a1')
    const outcome = await applyReadingReport('a1', { percent: 0.6, at: null })

    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.applied).toBe(true)

    const after = rawRow('a1')
    expect(after.reading_percent).toBe(0.6)
    expect(after.reading_position).toBeNull()
    expect(Number.isNaN(Date.parse(after.reading_updated_at as string))).toBe(false)

    // The clock *moved* rather than merely being set: it was null before (never
    // read), and the row the payload answers with is the same row
    expect(before.reading_updated_at).toBeNull()
    expect(outcome.ok && outcome.book.readingState).toEqual({
      position: null,
      percent: 0.6,
      updatedAt: after.reading_updated_at
    })
  })

  it('replaces a stored CFI with the newer fraction, which is D5’s whole point', async () => {
    // The Mac read this book precisely and the phone has now read further. The
    // position is *blanked* rather than left alone: if it survived, the Mac
    // would resume by `goTo(staleCfi)` — its reader tries the position first
    // and only falls back to the fraction when that is null or unresolvable.
    await seed('a2')
    db.setReadingState('a2', {
      position: 'epubcfi(/6/14!/4/2/2[c01]/1:0)',
      percent: 0.2,
      updatedAt: OLD
    })

    await applyReadingReport('a2', { percent: 0.42, at: null })

    const after = db.getBook('a2')!
    expect(after.readingState?.position).toBeNull()
    expect(after.readingState?.percent).toBe(0.42)
    expect(Date.parse(after.readingState!.updatedAt)).toBeGreaterThan(Date.parse(OLD))
  })

  it('takes a percent at either end of the range, and refuses nothing it was given', async () => {
    // 0 and 1 are both reports (started, and finished); the route's own
    // validation is what refuses anything else, so nothing is clamped here
    await seed('a3')
    await applyReadingReport('a3', { percent: 0, at: null })
    expect(db.getBook('a3')?.readingState?.percent).toBe(0)

    await applyReadingReport('a3', { percent: 1, at: null })
    expect(db.getBook('a3')?.readingState?.percent).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// AC21 — a stale report is refused, and nothing is written
// ---------------------------------------------------------------------------

describe('a report older than the row is refused (AC21)', () => {
  it('answers applied: false and leaves the row and the file byte-identical', async () => {
    const dir = await seed('s1')
    db.setReadingState('s1', { position: 'epubcfi(/6/2!/4)', percent: 0.5, updatedAt: OLD })

    // The whole row, and the whole file: "nothing was written when nothing
    // should have been" is a claim about both stores
    const rowBefore = JSON.stringify(rawRow('s1'))
    const fileBefore = await fs.readFile(join(dir, 'metadata.json'), 'utf8')

    const outcome = await applyReadingReport('s1', {
      percent: 0.05,
      // Older than the row's clock — a phone flushing a queue it collected
      // before the Mac read on
      at: '2025-12-31T23:59:59.000Z'
    })

    expect(outcome).toMatchObject({ ok: true, applied: false })
    expect(JSON.stringify(rawRow('s1'))).toBe(rowBefore)
    expect(await fs.readFile(join(dir, 'metadata.json'), 'utf8')).toBe(fileBefore)
    // …and the state a refusal answers with is the row that was already there,
    // so a client can resume from it without a second request (D6)
    expect(outcome.ok && outcome.book.readingState?.percent).toBe(0.5)
    expect(outcome.ok && outcome.book.readingState?.position).toBe('epubcfi(/6/2!/4)')
  })

  it('applies a report at exactly the row’s clock, which is the tie rule', async () => {
    // Adoption's own rule, reused: an equal timestamp gives the incoming record
    // the say rather than freezing a book behind a clock it cannot beat
    await seed('s2')
    db.setReadingState('s2', { position: null, percent: 0.3, updatedAt: OLD })

    const outcome = await applyReadingReport('s2', { percent: 0.7, at: OLD })

    expect(outcome).toMatchObject({ ok: true, applied: true })
    expect(db.getBook('s2')?.readingState?.percent).toBe(0.7)
  })

  it('applies a newer report, and an absent `at` whatever the clock says', async () => {
    await seed('s3')
    db.setReadingState('s3', { position: null, percent: 0.1, updatedAt: OLD })

    const newer = await applyReadingReport('s3', { percent: 0.8, at: '2026-06-01T00:00:00.000Z' })
    expect(newer).toMatchObject({ ok: true, applied: true })

    // A live read may omit `at` entirely — the server's clock applies, and the
    // row's clock does not get a veto over a report that has no claim about time
    const timeless = await applyReadingReport('s3', { percent: 0.9, at: null })
    expect(timeless).toMatchObject({ ok: true, applied: true })
    expect(db.getBook('s3')?.readingState?.percent).toBe(0.9)
  })

  it('applies an unusable row clock rather than refusing forever', async () => {
    // The same tie rule at its third face: a hand-edited or half-written
    // timestamp must not strand a book's progress behind it
    await seed('s4')
    db.setReadingState('s4', { position: null, percent: 0.1, updatedAt: 'not a date' })

    const outcome = await applyReadingReport('s4', { percent: 0.4, at: '2000-01-01T00:00:00.000Z' })

    expect(outcome).toMatchObject({ ok: true, applied: true })
    expect(db.getBook('s4')?.readingState?.percent).toBe(0.4)
  })
})

// ---------------------------------------------------------------------------
// AC22 — the status advances exactly as the Mac's own writes do
// ---------------------------------------------------------------------------

describe('read_status advances by nextReadStatus, never down (AC22)', () => {
  const CASES: { before: ReadStatus; percent: number; after: ReadStatus }[] = [
    { before: 'unread', percent: 0.05, after: 'reading' },
    { before: 'unread', percent: 0.5, after: 'reading' },
    { before: 'unread', percent: 0.98, after: 'read' },
    { before: 'reading', percent: 0.1, after: 'reading' },
    { before: 'reading', percent: 0.99, after: 'read' },
    // The demotion the rule exists to prevent: a book marked read, reopened at
    // the front by the phone, is still a book that was read
    { before: 'read', percent: 0.05, after: 'read' },
    { before: 'read', percent: 0.42, after: 'read' }
  ]

  it.each(CASES)('$before at $percent → $after', async ({ before, percent, after }) => {
    const id = `st-${before}-${percent}`
    await seed(id, before)

    await applyReadingReport(id, { percent, at: null })

    const row = db.getBook(id)!
    expect(row.readStatus).toBe(after)
    // **Parity, asserted against the function itself** rather than against a
    // second copy of the thresholds: this is the same `nextReadStatus` the
    // Mac's own page turns run, so the two writers cannot drift
    expect(row.readStatus).toBe(nextReadStatus(before, percent))
  })

  it('reports the advanced status in the payload it answers with', async () => {
    // The client's next decision (is this book finished?) is in the answer to
    // its own write, not in a follow-up request
    await seed('st-payload', 'unread')

    const outcome = await applyReadingReport('st-payload', { percent: 0.99, at: null })

    expect(outcome.ok && outcome.book.readStatus).toBe('read')
    expect(db.getBook('st-payload')?.readStatus).toBe('read')
  })
})

// ---------------------------------------------------------------------------
// AC23 — offline is a park, not a loss (invariant 12)
// ---------------------------------------------------------------------------

describe('with the share offline the report still lands (AC23)', () => {
  it('writes SQLite and parks the report for the next flush', async () => {
    const dir = await seed('o1')
    // `setLibraryRoot` only accepts a path, so offline is reached the way
    // `reading-state.test.ts` reaches it: a root that is not mounted. The
    // precondition is asserted, because a substitution that silently left the
    // suite online would pass every assertion below for the wrong reason.
    await nas.setLibraryRoot(join(root, 'does-not-exist'))
    expect(nas.isOnline()).toBe(false)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const outcome = await applyReadingReport('o1', { percent: 0.3, at: null })

      expect(outcome).toMatchObject({ ok: true, applied: true })
      // The row: reading is not interrupted by a dropped share
      expect(db.getBook('o1')?.readingState?.percent).toBe(0.3)
      // …and the share was not touched at all — not attempted and failed, which
      // is the same assertion `reading-state.test.ts` makes with the same spy
      expect((await readJson(dir)).reading_state).toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    // **The pending set, decided by its only reader.** It is module-private, so
    // the proof is behavioural: bring the share back and flush, and the
    // position the phone sent is what lands. A report that was dropped — or one
    // applied without being parked — writes nothing here.
    await nas.setLibraryRoot(root)
    await flushPending()

    const written = await readJson(dir)
    expect(written.reading_state).toMatchObject({ position: null, percent: 0.3 })
    expect(db.getBook('o1')?.readingState?.percent).toBe(0.3)
  })

  it('pushes the reading fields into the catalog without overwriting anything else', async () => {
    // The online path, and the same reason `reading-state.test.ts` tests it: a
    // progress save is not a metadata edit, so a title changed on another
    // machine must survive the phone's write riding along
    await seed('o2')
    await writeCatalog(root, [{ ...makeBook('o2', 'Edited On B'), tags: ['from-b'] }])

    await applyReadingReport('o2', { percent: 0.5, at: null })
    await librarySync.flushForTests()

    const entry = (await readCatalog(root))?.books.find((b) => b.id === 'o2')
    expect(entry?.title).toBe('Edited On B')
    expect(entry?.tags).toEqual(['from-b'])
    expect(entry?.readingState).toMatchObject({ position: null, percent: 0.5 })
    expect(entry?.readStatus).toBe('reading')
  })
})

// ---------------------------------------------------------------------------
// AC24 — an unknown book
// ---------------------------------------------------------------------------

describe('an unknown book (AC24)', () => {
  it('answers "no such book" and writes nothing anywhere', async () => {
    await seed('known')

    const outcome = await applyReadingReport('ghost', { percent: 0.5, at: null })

    // The router turns this into the uniform, reason-free 404 (D11)
    expect(outcome).toEqual({ ok: false })
    expect(db.getBook('ghost')).toBeNull()
    // Nothing was created for it and nothing was parked under its id
    await librarySync.flushForTests()
    expect((await readCatalog(root))?.books ?? []).toHaveLength(0)
    // …and the book that does exist is untouched
    expect(db.getBook('known')?.readingState).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The parse — the 400 table, decided without a socket
// ---------------------------------------------------------------------------

describe('parseReadingReport — the body the route refuses (400)', () => {
  it('accepts a fraction, with and without `at`', () => {
    expect(parseReadingReport({ percent: 0.6 })).toEqual({
      ok: true,
      report: { percent: 0.6, at: null }
    })
    expect(parseReadingReport({ percent: 0.42, at: '2026-09-22T09:12:00.000Z' })).toEqual({
      ok: true,
      report: { percent: 0.42, at: '2026-09-22T09:12:00.000Z' }
    })
    // The ends of the range are reports: 0 is "started", 1 is "finished"
    expect(parseReadingReport({ percent: 0 }).ok).toBe(true)
    expect(parseReadingReport({ percent: 1 }).ok).toBe(true)
  })

  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['an array', [0.5]],
    ['a bare number', 0.5],
    ['a bare string', '{"percent":0.5}'],
    ['no percent', {}],
    ['a string percent', { percent: '0.6' }],
    ['a null percent', { percent: null }],
    ['NaN', { percent: Number.NaN }],
    ['Infinity', { percent: Number.POSITIVE_INFINITY }],
    ['below the range', { percent: -0.1 }],
    ['above the range', { percent: 1.2 }],
    ['a percent that is a whole number of percent', { percent: 60 }],
    ['an `at` that is not a timestamp', { percent: 0.5, at: 'yesterday' }],
    ['an empty `at`', { percent: 0.5, at: '' }],
    ['a numeric `at`', { percent: 0.5, at: 1758531200000 }],
    // Present and wrong is refused rather than read as absent, which is the
    // read routes' own rule for `?minRating=` — a client that means "no `at`"
    // omits the member
    ['an explicit null `at`', { percent: 0.5, at: null }]
  ])('refuses %s — a 400, never a clamp or a default', (_label, body) => {
    expect(parseReadingReport(body)).toEqual({ ok: false })
  })

  it('ignores members it does not know', () => {
    // A client that sends more than the contract names is not malformed; the
    // report is read by its own field list, and D5's whole point is that a
    // position sent anyway is *ignored* — not stored, not refused
    const parsed = parseReadingReport({ percent: 0.5, position: 'epubcfi(/6/2!/4)', bogus: 1 })

    expect(parsed).toEqual({ ok: true, report: { percent: 0.5, at: null } })
  })
})

// ---------------------------------------------------------------------------
// D16/D17 — a queue lands newest, and the list hears about a write
// ---------------------------------------------------------------------------

describe('a queue of reports lands with the newest position, and a write tells the library (D16, D17)', () => {
  it('stamps the row with the report own clock, so a flush of two past reports keeps the latest (D16)', async () => {
    await seed('q1')
    const first = '2026-06-01T10:00:00.000Z'
    const second = '2026-06-01T10:05:00.000Z'

    // A phone that queued two reports while the Mac slept, flushing in order.
    // Both clocks are in the past, which is the whole point: the row must be
    // ordered by the client's clock, not by the moment the flush arrived.
    const older = await applyReadingReport('q1', { percent: 0.4, at: first })
    const newer = await applyReadingReport('q1', { percent: 0.9, at: second })

    expect(older.ok && older.applied).toBe(true)
    expect(newer.ok && newer.applied).toBe(true)

    const row = rawRow('q1')
    expect(row.reading_percent).toBeCloseTo(0.9, 6)
    expect(row.reading_updated_at).toBe(second)
    // The canonical record moved too, in the wire's own snake_case spelling
    // (`catalog.ts:247`) — the row and `metadata.json` cannot disagree about it
    expect(await readJson(join(root, 'books', 'q1'))).toMatchObject({
      reading_state: { percent: 0.9 }
    })
  })

  it('announces a write to the library list, and announces nothing when it refused one (D17)', async () => {
    await seed('b1', 'reading')
    db.setReadingState('b1', { position: null, percent: 0.5, updatedAt: OLD })

    const events: string[] = []
    const off = subscribe((event) => events.push(event))

    // Older than the row: refused, nothing written, so nothing announced.
    const refused = await applyReadingReport('b1', { percent: 0.2, at: '2025-01-01T00:00:00.000Z' })
    expect(refused.ok && refused.applied).toBe(false)
    expect(events).toEqual([])

    const applied = await applyReadingReport('b1', { percent: 0.7, at: null })
    expect(applied.ok && applied.applied).toBe(true)
    expect(events).toEqual(['libraryChanged'])

    off()
  })
})
