/**
 * The ask panel's decisions, as pure functions.
 *
 * Three things in the panel are judgments rather than rendering, and each one
 * is worth a test rather than an eyeball:
 *
 * 1. **What a stream does to the transcript.** `reduceAsk` is the only writer
 *    of the session state: a stream is identified by the id the caller minted,
 *    so an event for a request that has been superseded — the cancelled
 *    previous question is the ordinary case — cannot land in the new one.
 * 2. **What a probe verdict does to the rung** (D6). The verdict and the
 *    composer's override both feed one rule, and the override can only widen:
 *    a `weak` verdict cannot be talked back down to the pointer.
 * 3. **Which section name in an answer is a jump we can trust** (D7). CFIs are
 *    unproducible by a model, so citations are labels matched against the TOC
 *    we already hold — a lookup whose miss is visibly a miss.
 *
 * Pure: no store, no IPC, no DOM. The renderer has no DOM test harness
 * (`tasks.md`, slice-4 debt), so the panel's *decisions* live here, where
 * vitest can decide them, and only its layout lives in `ReaderAsk.tsx`.
 */

import type { AskDoneReason } from '@shared/ai.types'
import type { AskRung } from './ask-context'
import { parseProbe, scoreRecall, type RecallVerdict } from './recall'

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

export interface AskTurn {
  role: 'user' | 'assistant'
  text: string
  /** The answer is still arriving. Cleared by the terminal event. */
  streaming?: boolean
}

export type AskPhase = 'idle' | 'asking' | 'error'

export interface AskSession {
  /** The question in flight, or the last one that ran. Null before the first. */
  requestId: string | null
  phase: AskPhase
  turns: AskTurn[]
  /** What the last terminal event had to say — a timeout, a cut-off answer, a failure. */
  notice: string | null
}

export const EMPTY_ASK_SESSION: AskSession = {
  requestId: null,
  phase: 'idle',
  turns: [],
  notice: null
}

export type AskEvent =
  | { type: 'open'; requestId: string; question: string }
  | { type: 'chunk'; requestId: string; delta: string }
  | { type: 'settle'; requestId: string; reason: AskDoneReason }
  | { type: 'fail'; requestId: string; message: string }

/** Idle-based, because a local model's first token can legitimately take a minute. */
export const TIMEOUT_NOTICE = 'The model stopped responding — nothing arrived for two minutes.'

export const TRUNCATED_NOTICE = 'That answer was cut off at the model’s length limit.'

/**
 * Close out whatever was streaming: the flag comes off, and an answer that
 * never produced a token is dropped rather than left as an empty bubble. A
 * failure before the first token is a sentence, not a blank box.
 */
function settleTurns(turns: AskTurn[]): AskTurn[] {
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant' || !last.streaming) return turns
  const settled: AskTurn = { role: 'assistant', text: last.text }
  if (!last.text) return turns.slice(0, -1)
  return [...turns.slice(0, -1), settled]
}

/**
 * The session reducer. Every event carries its `requestId`, and an event whose
 * id is not the session's is returned as *the same state object* — so a stale
 * chunk is not merely ignored, it cannot notify subscribers either.
 */
export function reduceAsk(session: AskSession, event: AskEvent): AskSession {
  switch (event.type) {
    case 'open':
      return {
        requestId: event.requestId,
        phase: 'asking',
        notice: null,
        turns: [
          ...settleTurns(session.turns),
          { role: 'user', text: event.question },
          { role: 'assistant', text: '', streaming: true }
        ]
      }

    case 'chunk': {
      if (session.requestId !== event.requestId || !event.delta) return session
      const index = session.turns.length - 1
      const last = session.turns[index]
      if (!last || last.role !== 'assistant' || !last.streaming) return session
      const turns = session.turns.slice()
      turns[index] = { ...last, text: last.text + event.delta }
      return { ...session, turns }
    }

    case 'settle': {
      if (session.requestId !== event.requestId) return session
      return {
        ...session,
        phase: event.reason === 'timeout' ? 'error' : 'idle',
        notice:
          event.reason === 'timeout'
            ? TIMEOUT_NOTICE
            : event.reason === 'length'
              ? TRUNCATED_NOTICE
              : null,
        turns: settleTurns(session.turns)
      }
    }

    case 'fail': {
      if (session.requestId !== event.requestId) return session
      return {
        ...session,
        phase: 'error',
        notice: event.message,
        turns: settleTurns(session.turns)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The panel's status
// ---------------------------------------------------------------------------

export type AskStatus = 'idle' | 'probing' | 'streaming' | 'error'

/**
 * One status for two streams. A question outranks the probe, and an error
 * outranks both — a probe that fails is *not* an error the panel reports: D6
 * keeps the panel usable and the verdict lands on `unknown`.
 */
export function askStatusOf(session: AskSession, probing: boolean): AskStatus {
  if (session.phase === 'error') return 'error'
  if (session.phase === 'asking') return 'streaming'
  return probing ? 'probing' : 'idle'
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** The probe's id and its accumulating reply. The reply is never displayed. */
export interface AskProbe {
  requestId: string
  reply: string
}

/**
 * Accumulate one probe delta. A delta for any other request — or an empty one —
 * returns the *same object*, which is what keeps a burst of irrelevant events
 * from re-rendering the panel.
 */
export function appendProbeDelta(
  probe: AskProbe | null,
  requestId: string,
  delta: string
): AskProbe | null {
  if (!probe || probe.requestId !== requestId || !delta) return probe
  return { requestId: probe.requestId, reply: probe.reply + delta }
}

/**
 * The verdict for a probe's accumulated reply. The composition is here rather
 * than in the panel so that the one path that matters — a reply scored against
 * the section text the engine handed us — is the path the tests drive.
 */
export function probeVerdict(reply: string, sectionText: string | null | undefined): RecallVerdict {
  return scoreRecall(parseProbe(reply), sectionText)
}

// ---------------------------------------------------------------------------
// The rung
// ---------------------------------------------------------------------------

/**
 * The rung that will actually be sent. The override widens and never narrows:
 * a `weak` verdict means the model could not place this book, and a switch on
 * the composer is not evidence that it can (D6).
 */
export function effectiveRung(verdict: RecallVerdict | null, sendPassage: boolean): AskRung {
  return sendPassage || verdict === 'weak' ? 'passage' : 'pointer'
}

/**
 * What the panel says about the verdict, if anything. `strong` says nothing —
 * it is the bet paying off, and there is nothing to report.
 *
 * The passage clause depends on whether there *is* a passage: a `RECALL: no`
 * on a section whose text never loaded is a real verdict, and a notice
 * promising to send text we do not have would over-claim the egress.
 */
export function verdictNotice(verdict: RecallVerdict | null, hasPassage: boolean): string | null {
  if (verdict === 'weak') {
    return hasPassage
      ? 'The model could not place this book — questions this session go out with the passage too.'
      : 'The model could not place this book, and this section’s text has not loaded — questions go out without it.'
  }
  if (verdict === 'unknown') {
    return 'Unverified — answers about this book are reconstructed, not recalled.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface AskCitation {
  label: string
  href: string
}

/**
 * Two characters is the floor: a one-character label is a pronoun or a Roman
 * numeral as often as it is a section, and matching those offers a jump into
 * the wrong place — which is worse than no jump (D7).
 */
const MIN_LABEL_CHARS = 2

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collapse(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** The label as a whole word — `Chapter 4` must not match inside `Chapter 40`. */
function mentions(answer: string, label: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(label)}([^\\p{L}\\p{N}]|$)`, 'iu').test(
    answer
  )
}

/**
 * The one jump the panel offers: an answer that names a section the book's own
 * TOC names. The longest matching label wins, ties going to TOC order — an
 * answer that mentions two sections still offers one jump, and the more
 * specific label is the more useful one.
 *
 * The structural type is deliberate: `ReaderTocItem` satisfies it, so this
 * module never has to import the store.
 */
export function citationFor(
  answer: string | null | undefined,
  toc: readonly { label: string; href: string }[]
): AskCitation | null {
  if (!answer || !toc.length) return null
  const haystack = collapse(answer)
  let best: AskCitation | null = null
  let bestLength = 0
  for (const item of toc) {
    const label = collapse(item.label)
    if (label.length < MIN_LABEL_CHARS || label.length <= bestLength) continue
    if (!mentions(haystack, label)) continue
    best = { label: item.label, href: item.href }
    bestLength = label.length
  }
  return best
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

let counter = 0

/**
 * The panel mints the id, not the service (D9): it subscribes before it asks,
 * and a refused connection fails faster than a reply carrying a minted id
 * would arrive. Deliberately not `crypto.randomUUID` — an id has to be unique
 * within one renderer session, and nothing more.
 */
export function nextRequestId(): string {
  counter += 1
  return `ask-${Date.now().toString(36)}-${counter.toString(36)}`
}
