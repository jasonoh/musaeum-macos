import { randomUUID } from 'node:crypto'
import type { AiStatus } from '@shared/ai.types'
import { buildAskMessages, describeEgress, type AskRung } from '@ask/ask-context'
import { parseProbe, scoreRecall } from '@ask/recall'
import * as ai from '../ai'
import {
  askDeltaPayload,
  askDisclosurePayload,
  askDonePayload,
  askErrorPayload,
  askVerdictPayload,
  type HealthAi
} from './shape'

/**
 * The phone's ask, as the Mac receives it (`docs/rest-api.md` § `POST /api/ai/ask`,
 * D3 of `docs/superpowers/specs/2026-10-13-phone-ask-design.md`).
 *
 * This file is the relay's brain and none of its socket: it parses the request,
 * runs the *same* assembler and scorer the desktop panel runs, and reports what
 * happened as events a socket module can frame. Pure over its inputs apart from
 * the model call, which goes through `services/ai.ts`.
 */

/**
 * The longest section text a request may carry, in characters. The same ceiling
 * `services/ai.ts` already refuses a request above (`MAX_MESSAGE_CHARS`), against
 * the longest section the AI-panel work measured (18,405 characters). A request
 * past it is a 400, never a clamp: the text is a *prefix* of the section by the
 * contract, and a silently shortened prefix would score a probe against less
 * than the phone thought it sent.
 */
export const ASK_SECTION_TEXT_MAX_CHARS = 200_000

/** The route's body cap: the text at four UTF-8 bytes a character is 800,000, and the rest is small. */
export const ASK_BODY_MAX_BYTES = 1_048_576

const MAX_BOOK_ID_CHARS = 200
const MAX_LABEL_CHARS = 500
const MAX_SELECTION_CHARS = 50_000
const MAX_QUESTION_CHARS = 10_000

/** `preview` assembles and discloses without calling the model. */
export type AskWireMode = 'preview' | 'probe' | 'ask'

export interface AskWireRequest {
  bookId: string
  mode: AskWireMode
  rung: AskRung
  section: {
    label: string | null
    /** The section from its start — a prefix, never a window. */
    text: string | null
    /** Where the reader is within `text`, in characters. */
    offset: number | null
    truncated: boolean
  }
  fraction: number | null
  selection: string | null
  question: string | null
}

const BAD: unique symbol = Symbol('bad')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Absent and `null` are both "no value"; anything but a short-enough string is not a request. */
function textOrNull(value: unknown, max: number): string | null | typeof BAD {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > max) return BAD
  return value
}

function numberOrNull(value: unknown, min: number, max: number): number | null | typeof BAD {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return BAD
  return value
}

/**
 * Validate a request body. **Never throws** (invariant 12): a body this route
 * cannot make sense of is `{ ok: false }`, which the socket answers 400 — and
 * members it does not know are ignored, at both levels, because that is the
 * sentence that lets the contract grow without a version bump.
 */
export function parseAskRequest(
  body: unknown
): { ok: true; request: AskWireRequest } | { ok: false } {
  const bad = { ok: false } as const
  if (!isRecord(body)) return bad

  const bookId = typeof body.bookId === 'string' ? body.bookId.trim() : ''
  if (!bookId || bookId.length > MAX_BOOK_ID_CHARS) return bad

  const mode = body.mode
  if (mode !== 'preview' && mode !== 'probe' && mode !== 'ask') return bad

  const rung = body.rung === undefined || body.rung === null ? 'pointer' : body.rung
  if (rung !== 'pointer' && rung !== 'passage') return bad

  const rawSection = body.section === undefined || body.section === null ? {} : body.section
  if (!isRecord(rawSection)) return bad

  const label = textOrNull(rawSection.label, MAX_LABEL_CHARS)
  const text = textOrNull(rawSection.text, ASK_SECTION_TEXT_MAX_CHARS)
  const offset = numberOrNull(rawSection.offset, 0, Number.MAX_SAFE_INTEGER)
  const truncated = rawSection.truncated ?? false
  if (label === BAD || text === BAD || offset === BAD || typeof truncated !== 'boolean') return bad

  const fraction = numberOrNull(body.fraction, 0, 1)
  const selection = textOrNull(body.selection, MAX_SELECTION_CHARS)
  const question = textOrNull(body.question, MAX_QUESTION_CHARS)
  if (fraction === BAD || selection === BAD || question === BAD) return bad

  if (mode === 'ask' && !question?.trim()) return bad

  return {
    ok: true,
    request: {
      bookId,
      mode,
      rung,
      section: { label, text, offset, truncated },
      fraction,
      selection,
      question
    }
  }
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export type AskEventName = 'disclosure' | 'verdict' | 'delta' | 'done' | 'error'

/** How `runAsk` reports. The socket module turns each call into a frame on the wire. */
export type AskEmit = (event: AskEventName, data: object) => void

/** One server-sent event. `JSON.stringify` never emits a raw newline, so `data:` is one line. */
export function frame(event: AskEventName, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** `host[:port]` of an endpoint URL, or `''` when there is none or it does not parse. */
function hostOf(endpoint: string | null): string {
  if (!endpoint) return ''
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

/** The `ai` member of the health payload. Reads the status; never the key. */
export function healthAi(status: AiStatus): HealthAi {
  return {
    available: status.configured,
    reason: status.reason,
    isLocal: status.isLocal,
    host: hostOf(status.endpoint.value),
    model: status.model.value
  }
}

export interface RunAskInput {
  request: AskWireRequest
  book: { title: string; author: string | null }
  status: AiStatus
  emit: AskEmit
  /** Fires when the phone hangs up. Aborts the upstream request and silences `emit`. */
  signal?: AbortSignal
  /** Overridden in tests; the default is `services/ai.ts`'s own idle deadline. */
  idleTimeoutMs?: number
}

/**
 * One ask, start to terminal event. The three modes are one assembler called
 * three ways (D4): `preview` stops at the disclosure, `probe` collects the
 * model's reply and returns only its score, `ask` streams.
 *
 * **Resolves when a terminal event has been emitted, or when the phone hung up.**
 * After an abort nothing more is emitted — the reader is gone — and the
 * upstream request is canceled through `services/ai.ts`, which releases its slot.
 *
 * **A `preview` with a question previews an ask; without one, a probe.** The
 * assembler refuses a blank ask by design, so the choice is made here, once.
 */
export async function runAsk(input: RunAskInput): Promise<void> {
  const { request, book, status, signal } = input
  if (signal?.aborted) return

  const probing =
    request.mode === 'probe' || (request.mode === 'preview' && !request.question?.trim())
  const assembled = buildAskMessages({
    mode: probing ? 'probe' : 'ask',
    title: book.title,
    author: book.author,
    sectionLabel: request.section.label,
    fraction: request.fraction,
    question: request.question,
    sectionText: request.section.text,
    sectionOffset: request.section.offset,
    selection: request.selection,
    rung: request.rung
  })

  input.emit(
    'disclosure',
    askDisclosurePayload({
      text: describeEgress({
        endpoint: status.endpoint.value,
        model: status.model.value,
        payload: assembled.payload
      }),
      members: assembled.payload.members,
      rung: assembled.rung,
      windowed: assembled.payload.windowed,
      truncated: assembled.payload.truncated,
      host: hostOf(status.endpoint.value),
      isLocal: status.isLocal,
      model: status.model.value
    })
  )

  if (request.mode === 'preview') {
    input.emit('done', askDonePayload('stop'))
    return
  }

  await new Promise<void>((resolve) => {
    const requestId = `relay-${randomUUID()}`
    let reply = ''
    let hungUp = false

    const onAbort = (): void => {
      hungUp = true
      ai.cancel(requestId)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }

    const sink: ai.AskSink = {
      chunk: (delta) => {
        if (hungUp) return
        if (probing) reply += delta
        else input.emit('delta', askDeltaPayload(delta))
      },
      done: (reason) => {
        // `canceled` is the arm that fires in practice — every exercised abort reaches
        // here through `ai.cancel`; `hungUp` only covers a terminal that arrives after
        // the reader is already gone.
        if (hungUp || reason === 'canceled') return finish()
        // A partial reply that parses is still scored — `RECALL: no` followed by
        // a dropped connection is the model saying it cannot place the book.
        if (probing) {
          input.emit(
            'verdict',
            askVerdictPayload(scoreRecall(parseProbe(reply), request.section.text))
          )
        }
        input.emit('done', askDonePayload(reason))
        finish()
      },
      error: (message) => {
        if (!hungUp) input.emit('error', askErrorPayload(message))
        finish()
      }
    }

    try {
      ai.ask(
        { requestId, mode: assembled.mode, messages: assembled.messages },
        { sink, idleTimeoutMs: input.idleTimeoutMs }
      )
    } catch (err) {
      input.emit('error', askErrorPayload(err instanceof Error ? err.message : String(err)))
      finish()
    }
  })
}
