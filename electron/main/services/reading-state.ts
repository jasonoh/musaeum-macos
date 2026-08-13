import { join } from 'path'
import type { ProgressReport, ReadStatus, ReadingState } from '@shared/book.types'
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

export async function saveProgress(report: ProgressReport, now = Date.now()): Promise<void> {
  const book = db.getBook(report.bookId)
  if (!book) return

  const state: ReadingState = {
    position: report.position,
    percent: Math.min(1, Math.max(0, report.percent)),
    updatedAt: new Date(now).toISOString()
  }
  db.setReadingState(book.id, state)

  const status = nextReadStatus(book.readStatus, state.percent)
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
    librarySync.upsertCatalog([updated])
    pending.delete(report.bookId)
  } else {
    pending.set(report.bookId, report)
  }
}

/** Flush every unsaved position. Called on `will-quit`. */
export async function flushPending(): Promise<void> {
  const reports = [...pending.values()]
  pending.clear()
  for (const report of reports) {
    await saveProgress({ ...report, final: true })
  }
}

export function resetForTests(): void {
  lastJsonWrite.clear()
  pending.clear()
}
