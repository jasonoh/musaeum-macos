import { dirname } from 'path'
import type { ReflowProgress, ReflowResult } from '@shared/book.types'
import { resolveBookFile } from './book-bytes'
import * as events from './events'
import * as sidecar from './sidecar'

/**
 * The app's one door to the reflow pipeline — slice 2's `reflow_pdf` RPC.
 *
 * Four rules sit between the RPC and the reader, and each one was measured on the
 * way in:
 *
 * - **The source is resolved by extension**, through `book-bytes`'s own rule
 *   (invariant 2), so a book renamed after import still reflows — and the folder
 *   the pass writes `derived/` into is *that file's* folder, so no caller can aim
 *   the artifact at a folder the app does not own (slice 2's AC2, pinned there by
 *   `test_the_source_must_live_in_the_book_folder`).
 * - **The call carries its own deadline.** A pass is minutes: *Universe* (535
 *   pages) measured 176 s on 2026-10-08 and the helper runs 0.5–1.3 s per page.
 *   `services/sidecar.ts`'s 120 s default would answer a working pass as a
 *   failure — and because a timeout only drops the *pending call*, the pass would
 *   go on and write its artifact, so the next open would find a cache the reader
 *   had already been told did not exist.
 * - **One call per book.** The sidecar takes its own per-artifact lock (slice 2,
 *   D7/AC6), so two opens cannot run two passes; this map is what stops the app
 *   *making* a second call for a pass already in flight, which is what AC6's
 *   "does not start a second pass" means from this side.
 * - **A refusal is retried once, and only when a retry can help** (R4).
 *
 * Progress is re-broadcast on the app's own channel rather than handed to the
 * caller: the frames arrive on the sidecar's notification stream whether or not
 * anything is awaiting the result.
 */

/**
 * Twenty minutes. Not a guess: the pass is O(pages) at 0.2–1.3 s per page per
 * half (slice 2's measurement), so the corpus's largest book is a few minutes and
 * D4R's own estimate for a 1,247-page textbook is 5–10. A pass that has not
 * answered in twenty is one to report rather than to wait on.
 */
export const REFLOW_TIMEOUT_MS = 20 * 60_000

/**
 * The one verdict a second attempt can fix.
 *
 * `unstable_layout` is the helper failing pages on a *later* run of a book it
 * laid out before — measured in slice 2 as three refusals across six full corpus
 * runs, every one healed by a retry. The rest are facts about the book or the
 * machine: `no_text_layer` (the ~10% of PDF-only books with no text at all,
 * which is D6's whole justification), `unreadable` (a PDF no parser opens),
 * `no_layout` (the helper missing or unsupported) and `write_failed` (the share).
 * Retrying those spends minutes to arrive at the same sentence.
 */
export const RETRY_VERDICTS = new Set(['unstable_layout'])

/**
 * What the sidecar answers, spelled as `reflow/produce.py` writes it.
 * `docs/data-contracts.md`'s `reflow_pdf` block is the same list from the
 * document's side.
 */
interface SidecarReflow {
  status?: unknown
  reason?: unknown
  verdict?: unknown
  epub?: unknown
  stamp_file?: unknown
  pages?: unknown
  bytes?: unknown
  seconds?: unknown
}

const inflight = new Map<string, Promise<ReflowResult>>()
/** The latest frame per running pass — what the wire's 202 reports. */
const latest = new Map<string, { phase: string; completed: number; total: number }>()
/** A refused book's reason and when to forget it, so a poll does not re-run a doomed pass. */
const refusals = new Map<string, { reason: string; until: number }>()
/** How long a refusal answers for the book before a request may try again. */
export const REFUSAL_TTL_MS = 60_000
let subscribed = false

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Subscribe to the sidecar's frames once, for the process, and re-broadcast them
 * in the app's spelling.
 *
 * Subscribed lazily rather than at import: `services/sidecar.ts`'s registry is
 * process-lifetime, so one subscription is the right number, and a per-call one
 * would leak a listener per open — the mistake `src/hooks/useAi.ts` documents for
 * the renderer's half of the same idea. A frame carries its own `book_id`, so two
 * books' passes on the sidecar's four threads are told apart by payload and
 * neither needs a listener of its own.
 */
function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  sidecar.onNotification('reflow_progress', (params) => {
    const frame = (params ?? {}) as Record<string, unknown>
    const bookId = text(frame.book_id)
    const phase = text(frame.phase)
    if (!bookId || !phase) return
    const reason = text(frame.reason)
    if (inflight.has(bookId)) {
      latest.set(bookId, { phase, completed: count(frame.completed), total: count(frame.total) })
    }
    events.broadcast('reflowProgress', {
      bookId,
      phase,
      completed: count(frame.completed),
      total: count(frame.total),
      ...(reason ? { reason } : {})
    } satisfies ReflowProgress)
  })
}

/** Drop the in-flight map and the subscription. For tests only. */
export function resetForTests(): void {
  inflight.clear()
  latest.clear()
  refusals.clear()
  subscribed = false
}

/**
 * Produce — or find — a book's reflow, or say why not (D6).
 *
 * Rejects only for the **pre-flight** failures, the same contract
 * `metadata.rehydrateBook` documents: the metadata engine is unavailable, or the
 * book has no PDF to reflow. A pass that runs and refuses **resolves**, with
 * `status: 'fallback'` and the pipeline's own sentence — because that is a normal
 * outcome (D6, invariant 12) and not an error the renderer should have to tell
 * apart from a crash.
 */
export function ensure(bookId: string): Promise<ReflowResult> {
  const existing = inflight.get(bookId)
  if (existing) return existing
  latest.set(bookId, { phase: 'start', completed: 0, total: 0 })
  const run = pass(bookId)
    .then((result) => {
      // Only a pass that ran has an outcome to remember; a pre-flight rejection
      // skips this and is surfaced by the caller.
      if (result.status === 'fallback') {
        refusals.set(bookId, { reason: result.reason, until: Date.now() + REFUSAL_TTL_MS })
      } else {
        refusals.delete(bookId)
      }
      return result
    })
    .finally(() => {
      inflight.delete(bookId)
      latest.delete(bookId)
    })
  inflight.set(bookId, run)
  return run
}

/**
 * The running pass's latest frame, or null when none is running — non-null
 * exactly while `ensure(bookId)` is in flight, `start` before the first frame.
 */
export function wireStatus(
  bookId: string
): { phase: string; completed: number; total: number } | null {
  return inflight.has(bookId) ? (latest.get(bookId) ?? null) : null
}

/** The reason of a refusal in the last `REFUSAL_TTL_MS`, else null. */
export function recentRefusal(bookId: string): string | null {
  const hit = refusals.get(bookId)
  if (!hit) return null
  if (Date.now() >= hit.until) {
    refusals.delete(bookId)
    return null
  }
  return hit.reason
}

async function pass(bookId: string): Promise<ReflowResult> {
  subscribeOnce()
  sidecar.assertAvailable()

  const pdf = await resolveBookFile(bookId, 'pdf')
  if (!pdf) throw new Error('This book has no PDF file to reflow')

  const bookDir = dirname(pdf)
  const first = await ask(bookDir, pdf, bookId)
  if (first.status !== 'fallback' || !RETRY_VERDICTS.has(first.verdict)) return first

  // Announced, so a bar that restarts has said why rather than looking stuck.
  events.broadcast('reflowProgress', {
    bookId,
    phase: 'retrying',
    completed: 0,
    total: 0,
    reason: first.reason
  } satisfies ReflowProgress)
  return ask(bookDir, pdf, bookId)
}

async function ask(bookDir: string, pdf: string, bookId: string): Promise<ReflowResult> {
  const raw = await sidecar.call<SidecarReflow>(
    'reflow_pdf',
    { book_dir: bookDir, pdf_path: pdf, book_id: bookId },
    REFLOW_TIMEOUT_MS
  )
  return {
    status:
      raw.status === 'produced' ? 'produced' : raw.status === 'cached' ? 'cached' : 'fallback',
    reason: text(raw.reason),
    verdict: text(raw.verdict),
    epub: text(raw.epub),
    stampFile: text(raw.stamp_file),
    pages: count(raw.pages),
    bytes: count(raw.bytes),
    seconds: count(raw.seconds)
  }
}
