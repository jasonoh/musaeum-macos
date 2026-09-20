/**
 * The ask panel's contract — the seam between two halves that deliberately
 * live in different processes.
 *
 * The renderer owns *what to say*: it is what holds the pointer (title, author,
 * section label, fraction), the section's own text and the reader's selection,
 * so the prompt is assembled on that side. The main process owns *how it
 * travels*: endpoint, model, key, SSE, cancellation, timeouts. The renderer
 * therefore never holds a URL it was not already given, and never sees the API
 * key at all. Reasoning: `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md` D2.
 */

import type { ResolvedSetting } from './settings.types'

/** One turn, in the OpenAI-compatible wire shape the client posts. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * A `probe` asks the model to place the book — it is scored locally and never
 * shown to the reader; an `ask` is a question from the reader.
 */
export type AskMode = 'probe' | 'ask'

/**
 * One request.
 *
 * The **id is minted by the caller**, not by the service. The panel subscribes
 * to the stream before it asks, which is the only way a failure that arrives
 * faster than the IPC reply can be — a refused connection is immediate, and a
 * service-minted id would leave that error with nobody listening.
 */
export interface AskRequest {
  requestId: string
  mode: AskMode
  messages: ChatMessage[]
}

/**
 * How a stream ended. Only a failure is an error; every one of these is an
 * outcome, including `cancelled` — the reader closing the panel is normal.
 */
export type AskDoneReason = 'stop' | 'length' | 'cancelled' | 'timeout'

export interface AiChunkEvent {
  requestId: string
  delta: string
}

export interface AiDoneEvent {
  requestId: string
  reason: AskDoneReason
}

export interface AiErrorEvent {
  requestId: string
  message: string
}

/**
 * One read of whether the ask panel can work at all, and against what.
 *
 * `configured` is the gate the composer reads. The endpoint always resolves —
 * there is a compiled-in localhost default — while **the model has no default,
 * deliberately**: inventing one would produce "model not found" on a machine
 * that runs the server but not that model. An unset model is therefore reported
 * as unavailable *with a reason*, the shape Python and Calibre already use.
 */
export interface AiStatus {
  configured: boolean
  /** Why the panel is unavailable, when it is. Null when it works. */
  reason: string | null
  endpoint: ResolvedSetting
  model: ResolvedSetting
  /** The endpoint is loopback, so nothing sent to it leaves this machine. */
  isLocal: boolean
  /** A key is in force. Never the key itself — this is a boolean on purpose. */
  hasKey: boolean
}

/**
 * A Test press, against the values in the form rather than the stored config:
 * the whole point of the button is to answer *before* committing, and a probe
 * that read `app_config` could not report on a key just pasted.
 *
 * The key travels as a parameter. The parent spec's D2 sentence about the key
 * never crossing the IPC boundary is about the streaming path (`ai:ask`);
 * `settings:save` has always carried it, and so does this.
 */
export interface AiProbeRequest {
  baseUrl: string
  model: string | null
  apiKey: string | null
}

/**
 * What a probe learned. Six verdicts, because the honest answer to "is my key
 * working?" has six shapes and three of them are not about the key at all:
 *
 * - `rejected` — a 401. The key is the problem.
 * - `refused` — a status that says the *request* was refused rather than the
 *   key rejected: a 403, a 429, a 5xx. A 403 is as often a network block as a
 *   bad key (measured: `api.groq.com/openai/v1/models` answers 403 with a
 *   network message and no key involved), so it is never reported as "your key
 *   is bad".
 * - `no-model-list` — 404/405/501. The endpoint has no `/models`, so the key
 *   was *not checked*, and the sentence says that rather than blaming it.
 */
export type AiProbeVerdict =
  'ok' | 'rejected' | 'refused' | 'no-model-list' | 'unreachable' | 'timeout'

export interface AiProbeResult {
  verdict: AiProbeVerdict
  /** One sentence for the UI, in the diagnose-not-errno discipline. */
  message: string
  /** What was actually fetched, so the answer names what it hit. */
  url: string
  isLocal: boolean
  hasKey: boolean
  /** The ids the endpoint listed — sorted, capped, empty when it listed none. */
  models: string[]
  /** How many it listed before the cap, so a capped list says so. */
  modelCount: number
  /** Is the model in the request among them? Null when unasked or unlisted. */
  modelOffered: boolean | null
  /** Wall clock for the round trip, so "it works" can carry "and it is fast". */
  elapsedMs: number
}
