import type { Book } from '@shared/book.types'
import * as db from '../db'
import { broadcast } from '../events'
import * as readingState from '../reading-state'

/**
 * The reading-progress report — the one write this API has (D4, D5, D6).
 *
 * **It is a translator, not a second writer.** Everything that happens to a
 * book when its position moves is decided by `services/reading-state.ts`'s
 * `saveProgress`, which the Mac's own reader already calls: which stores are
 * written on which clock, when a report is parked for the next flush, and the
 * `nextReadStatus` rule that advances (and never demotes) `read_status`. This
 * module decides only the two things a *phone* introduces — what a fraction on
 * the wire means, and which reports are too old to apply — and then hands
 * `saveProgress` a report shaped exactly as the Mac's own reader shapes one.
 * A route that set the columns itself would be the second home for the
 * percent/status rules, which is what invariant 5 and AC22 exist to prevent.
 *
 * **The wire carries a fraction, and the position is deliberately blanked
 * (D5).** Two engines cannot compare coordinates, so the only thing that can
 * order them is the clock: a report writes `position: null` so the newer
 * fraction wins on the Mac, whose reader tries the stored position first and
 * falls back to the fraction only when that position is null
 * (`ReaderEngine.tsx:176-184`). The Mac's own next page turn writes a fresh
 * CFI there, so the null is a transient that means "the shared coordinate is a
 * fraction right now" — AC25/26's probe.
 *
 * **A report is ordered by its own clock (D6).** Every Mac-side writer is the
 * newest by construction, so `saveProgress` has never needed a comparison. A
 * phone does: it queues progress while the Mac is asleep or the share is down,
 * and a flush after a week of Mac reading would drag the book backwards if it
 * were applied blindly. So a report whose `at` is *older* than the row's
 * `reading_updated_at` is refused — `applied: false`, and nothing is written
 * at all (AC21's second half, which is the half that matters: "nothing was
 * written when nothing should have been"). `at` absent means *apply* rather
 * than refuse, which is the same tie rule adoption already uses — equal or
 * unparseable timestamps give the incoming record the say
 * (`docs/invariants/reader.md`).
 *
 * **Validation refuses rather than repairs.** A `percent` that is not a number
 * in 0–1 is a 400: clamping it would answer a client's typo with a write it
 * did not ask for, and `saveProgress` already clamps what it is given, so a
 * clamped route would be a second, invisible place where the fraction changed
 * meaning. The discipline is the read routes' own (`query.ts`): a `limit` of
 * `1.5` is refused, not truncated.
 *
 * Pure except for the two service calls: the parse is a pure function of a
 * JSON value, and `applyReadingReport` is the one thing in the API that writes.
 */

/** The fraction bounds, named so the validator and the message cannot drift. */
export const MIN_PERCENT = 0
export const MAX_PERCENT = 1

/**
 * A report as the wire may carry it. `at` is the client's clock, or null when
 * the client omitted it — the server's own clock applies then.
 */
export interface ReadingReport {
  percent: number
  at: string | null
}

export type ParsedReport = { ok: true; report: ReadingReport } | { ok: false }

/** A body this route cannot make sense of: answered 400, never defaulted. */
const INVALID_REPORT: { ok: false } = { ok: false }

/**
 * A parsed body, or a refusal.
 *
 * Three rules, and each is a 400 rather than a default:
 *
 * - the body is **one JSON object** — not an array, not a bare number, not
 *   nothing at all (an empty body, and a body that is not JSON, both land here
 *   because the router parses before it calls this);
 * - `percent` is **present and is a number in 0–1** — `"0.6"` (a string) and
 *   `null` are not numbers, and `1.2` is out of the range the contract states;
 * - `at`, *when it is there*, is **a timestamp `Date.parse` accepts**. An
 *   absent `at` is not an error — the server's clock applies — but a present
 *   and unusable one is refused rather than ignored, which is the read routes'
 *   own rule for a parameter that is there and wrong (`?minRating=`). An
 *   explicit `null` is therefore *not* read as "absent": a client that means
 *   "no `at`" omits the member.
 */
export function parseReadingReport(body: unknown): ParsedReport {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return INVALID_REPORT

  const { percent, at } = body as { percent?: unknown; at?: unknown }

  if (typeof percent !== 'number' || !Number.isFinite(percent)) return INVALID_REPORT
  if (percent < MIN_PERCENT || percent > MAX_PERCENT) return INVALID_REPORT

  if (at === undefined) return { ok: true, report: { percent, at: null } }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return INVALID_REPORT

  return { ok: true, report: { percent, at } }
}

/**
 * What applying a report came to. `{ ok: false }` is the unknown book — the
 * router answers it 404, uniformly and reason-free (D11), because a phone has
 * no business learning which ids this machine holds.
 */
export type ReadingOutcome = { ok: false } | { ok: true; applied: boolean; book: Book }

/**
 * Is this report older than the row's own clock?
 *
 * Three ways to answer "no, apply it": no `at` at all, a row that has never
 * been read (no clock to lose to), and a row clock that does not parse — the
 * last two are the adoption tie rule (`docs/invariants/reader.md`): an
 * unparseable timestamp gives the incoming record the say, rather than
 * freezing a book's progress behind a corrupt value forever.
 */
function isStale(at: string, updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false
  const clock = Date.parse(updatedAt)
  if (Number.isNaN(clock)) return false
  return Date.parse(at) < clock
}

/**
 * Apply a report to a book, through `saveProgress` — or refuse it, having
 * written nothing.
 *
 * The order is deliberate and is AC21's whole content: the clock is compared
 * against the row **before** `saveProgress` is called, so a refused report
 * does not touch SQLite, `metadata.json`, the catalog or the pending set. The
 * row afterwards is byte-identical, not merely equivalent.
 *
 * `final: true` is D5's own shape: a report from the phone is a session
 * boundary by nature — the phone read a whole way and then stopped — so it
 * takes the tier that also flushes the catalog and clears the parked report,
 * and the phone never has to send a second "and I'm done" message. The cost is
 * per *report*, not per write, which is why the contract obliges a client to
 * report a session rather than a page turn (`docs/rest-api.md`).
 *
 * **Awaited, including the `metadata.json` write.** `saveProgress` writes
 * SQLite synchronously before its first `await`, so answering early would
 * still report the new row — but the caller would not know whether the share
 * write landed, and this route's answer (`applied: true`) is a claim about
 * what happened. The cost is honest and bounded: with the share wedged, the
 * answer waits on the same kernel timeout the byte routes' transfer cap
 * documents, and `saveProgress` parks the report rather than losing it
 * (invariant 12), so the phone's retry is safe whatever the share is doing.
 */
export async function applyReadingReport(
  bookId: string,
  report: ReadingReport
): Promise<ReadingOutcome> {
  const book = db.getBook(bookId)
  if (!book) return { ok: false }

  if (report.at && isStale(report.at, book.readingState?.updatedAt)) {
    // Refused, and nothing written: the row this answers with is the row that
    // was already there, which is why the caller can hand a client the current
    // state either way (D6).
    return { ok: true, applied: false, book }
  }

  // The Mac's own shape, verbatim: no position (D5), the clamp and the status
  // and the three stores are all `saveProgress`'s business, not this module's.
  //
  // **The row is stamped with the report's own clock (D16).** `saveProgress`
  // defaults `now` to `Date.now()`, which is right for the Mac's reader — it is
  // the newest writer by construction — and wrong for a phone flushing what it
  // queued while the Mac slept: the row would be stamped at the *flush*, so the
  // queue's second report (`at = T2`, still `< Date.now()`) would look older
  // than the row and be refused, leaving the *earliest* position on disk — the
  // backwards drag D6 exists to prevent. One clock domain ordering one device's
  // reports is what D6 asks for: T1 then T2 lands T2. A report with no `at`
  // keeps the default, because the server's clock is the honest answer when the
  // client did not offer one.
  await readingState.saveProgress(
    {
      bookId,
      position: null,
      percent: report.percent,
      final: true
    },
    report.at ? Date.parse(report.at) : undefined
  )

  // **The list the Mac resumes from has to hear about this (D17).** Nothing
  // broadcasts for a progress write: the renderer's own reader reloads the store
  // by hand once its flush is final (`ReaderView.tsx:93-96`, with the comment
  // saying why), and a phone has no renderer to do that for it — so without this
  // a book the phone moved keeps reading from whatever the list was loaded with.
  // One event, the one every other write service already emits, and only after a
  // write that happened: a refused report changed nothing, so it announces
  // nothing.
  broadcast('libraryChanged')

  // Re-read rather than reuse: `saveProgress` may have advanced `read_status`
  // and moved the clock, and the payload this answers with is the state a
  // client resuming from it would get from `GET /api/books/{id}` — one row
  // read, in-process, so the two cannot describe the book differently.
  return { ok: true, applied: true, book: db.getBook(bookId) ?? book }
}
