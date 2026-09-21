import { join } from 'path'
import type { Book, ProgressReport, ReadStatus, ReadingState } from '@shared/book.types'
import * as db from './db'
import { writeMetadataJson } from './importer'
import * as librarySync from './library-sync'
import * as nas from './nas-manager'

/**
 * Where reading position goes, and how often.
 *
 * The three stores cost wildly different amounts, so they are written on
 * different clocks: SQLite is in-process and free, metadata.json is a ~2KB
 * per-book write, and catalog.json is a whole-library rewrite over SMB. A
 * naive "write everything on a throttle" would rewrite ~10MB every 30
 * seconds of reading.
 *
 * | trigger        | sqlite | metadata.json    | catalog.json |
 * |----------------|--------|------------------|--------------|
 * | page turn      | yes    | if >30s since    | no           |
 * | close / quit   | yes    | yes              | yes          |
 *
 * All of it lives here rather than in the reader so the policy is testable
 * without a browser.
 */

const JSON_INTERVAL_MS = 30_000

/**
 * The only fields a progress save may push to catalog.json. Reading is not a
 * deliberate edit: the rest of this machine's copy of the book can be days
 * older than the catalog's, so upserting the whole record would quietly
 * overwrite a title, tag or rating changed on another machine — a class of
 * data loss that did not exist while catalog upserts only ever followed an
 * edit or a hydration.
 */
const READING_FIELDS: readonly (keyof Book)[] = ['readingState', 'readStatus']

const lastJsonWrite = new Map<string, number>()
/** Books whose latest position has not reached the NAS yet — flushed at quit. */
const pending = new Map<string, ProgressReport>()

/**
 * Read status only ever advances. A book you marked read stays read when you
 * reopen it, which is what makes a manual override stick.
 */
export function nextReadStatus(current: ReadStatus, percent: number): ReadStatus {
  if (current === 'read') return 'read'
  return percent >= 0.98 ? 'read' : 'reading'
}

/**
 * Record that the *user* decided this book's read status — the one signal that
 * outranks an automatic one.
 *
 * `read_status` is one of the two fields this module treats as reading state
 * (`READING_FIELDS`), and `reading_updated_at` is that state's clock; every
 * automatic writer moves it in the same call that records the position. A
 * manual change did not, so it was invisible to `library-sync.ts`'s adoption
 * comparison — the incoming catalog record is ordered by that clock and wins
 * outright on a tie — and the decision came back reverted on the next launch
 * even with the canonical `metadata.json` holding it.
 *
 * Pass the patch **and the row as it was before the write**: what makes this a
 * decision is the difference, and after the write every patch restates the row
 * (same guard, same reason as `field-overrides.markFromPatch`).
 */
export function noteStatusChange(bookId: string, patch: Partial<Book>, before: Book | null): void {
  if (!('readStatus' in patch)) return
  if (before && before.readStatus === patch.readStatus) return
  db.touchReadingState(bookId, new Date().toISOString())
}

/**
 * `advanceStatus: false` is the replay case — see `flushPending`. A report
 * arriving from a reader is news about the status and advances it; the same
 * report replayed at quit is not.
 */
export async function saveProgress(
  report: ProgressReport,
  now = Date.now(),
  advanceStatus = true
): Promise<void> {
  const book = db.getBook(report.bookId)
  if (!book) return

  const state: ReadingState = {
    position: report.position,
    percent: Math.min(1, Math.max(0, report.percent)),
    updatedAt: new Date(now).toISOString()
  }
  db.setReadingState(book.id, state)

  const status = advanceStatus ? nextReadStatus(book.readStatus, state.percent) : book.readStatus
  if (status !== book.readStatus) db.updateBook(book.id, { readStatus: status })

  const root = nas.getLibraryRoot()
  if (!root || !nas.isOnline() || !book.nasPath) {
    // Reading is not interrupted by a dropped share: SQLite has the position
    // and the NAS catches up on the next report once the mount is back
    pending.set(report.bookId, report)
    return
  }

  // Corrected per controller ruling: with no previous write, `last` is
  // `undefined` and the interval comparison against 0 would wrongly read as
  // "not yet due" for a session's very first report. A session's first
  // report must always land on disk.
  const last = lastJsonWrite.get(book.id)
  const dueForJson = report.final || last === undefined || now - last >= JSON_INTERVAL_MS
  if (!dueForJson) {
    pending.set(report.bookId, report)
    return
  }

  const updated = { ...db.getBook(book.id)!, readingState: state, readStatus: status }
  try {
    await writeMetadataJson(join(root, book.nasPath), updated)
    lastJsonWrite.set(book.id, now)
  } catch (err) {
    console.warn(`[reading] could not write metadata.json for ${book.id}:`, err)
    pending.set(report.bookId, report)
    return
  }

  if (report.final) {
    librarySync.updateCatalogFields([updated], READING_FIELDS)
    pending.delete(report.bookId)
  } else {
    pending.set(report.bookId, report)
  }
}

/**
 * Flush every unsaved position. Called (indirectly, see below) on quit.
 *
 * `saveProgress` dispatches its catalog.json write fire-and-forget, so
 * awaiting the metadata.json writes alone would let quit's `teardown` close
 * the database and exit with the catalog's read-modify-write still in flight
 * — the policy table's "quit → catalog.json" cell honored only when the app
 * happens to keep running. Awaiting the queue closes that: it runs inside the
 * caller's existing timeout (`flushPendingBeforeQuit`), and the queue never
 * rejects, so a dead share still costs at most that one bound.
 */
export async function flushPending(): Promise<void> {
  const reports = [...pending.values()]
  pending.clear()
  for (const report of reports) {
    // `advanceStatus: false` — a replayed report is not news about the status.
    // Its status implication was already applied when it first arrived (every
    // report runs `nextReadStatus`, whatever the write tier: the branch above
    // is not the only place it runs), and the user may have decided the status
    // since. Re-deriving it here is how quit undid a manual Unread: the row
    // said Unread, the parked report said `percent: 0.06` of a book that was
    // Reading when it was parked, and the flush put Reading back into all three
    // stores. The position, which is what this function is for, still lands.
    await saveProgress({ ...report, final: true }, Date.now(), false)
  }
  await librarySync.flushPendingWrites()
}

/**
 * Quit must never hang on a dead or stalled NAS share: `flushPending` writes
 * metadata.json and then waits for the queued catalog.json writes to land,
 * both over SMB, and either can block indefinitely if the mount is wedged
 * rather than cleanly offline. 3s is comfortably more than a healthy SMB
 * write of a few KB needs, and short enough that quit never visibly hangs —
 * losing the pending NAS write on timeout is acceptable (SQLite already has
 * the position, and the next successful sync reconciles it back in via
 * `library-sync.ts`'s adoption-time reconcile); wedging app exit is not.
 *
 * `flush` is injectable so the timeout race itself is testable without a
 * real stalled filesystem — tests pass a promise that never resolves.
 */
const QUIT_FLUSH_TIMEOUT_MS = 3_000

export async function flushPendingBeforeQuit(
  timeoutMs = QUIT_FLUSH_TIMEOUT_MS,
  flush: () => Promise<void> = flushPending
): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([flush(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export function resetForTests(): void {
  lastJsonWrite.clear()
  pending.clear()
}
