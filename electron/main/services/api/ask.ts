import type { AskRung } from '@ask/ask-context'

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
