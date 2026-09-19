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
