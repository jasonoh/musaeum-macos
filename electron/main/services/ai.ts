import type { AiStatus, AskDoneReason, AskRequest } from '@shared/ai.types'
import type { ResolvedSetting, SettingSource } from '@shared/settings.types'
import { getConfig } from './db'
import { broadcast } from './events'

/**
 * The AI client: one OpenAI-compatible endpoint, streamed to the renderer.
 *
 * Three rules this file exists to keep:
 *
 * 1. **It runs in the main process.** `index.html`'s CSP is
 *    `connect-src 'self' ws: musaeum:`, and that is a stated promise ("book
 *    content can never execute and an EPUB cannot phone home"), not an
 *    oversight. A book's own scripts must never have a network path, so the
 *    renderer hands over assembled messages and this module holds the URL, the
 *    model and the key.
 * 2. **Localhost by default.** The compiled-in endpoint is a local model, so the
 *    feature ships with exactly zero egress; pointing it at a cloud host is a
 *    choice made in Settings, and `isLocal` is what lets the panel say so.
 * 3. **Nothing here touches the library.** No NAS, no `metadata.json`, no Python
 *    sidecar — this file's only imports are config and the event bus, which is
 *    also why it is testable without a running app.
 *
 * Reasoning and the payload ladder: `docs/superpowers/specs/2026-09-19-reader-ai-panel-design.md`.
 */

/** The compiled-in endpoint. Loopback, so the default posture is "no egress". */
export const DEFAULT_AI_BASE_URL = 'http://localhost:11434/v1'

/**
 * `app_config` keys. Defined here and imported by `settings.ts` so the raw
 * strings have exactly one home — the same reason `resolveGoogleBooksKey` lives
 * with the sidecar rather than with the settings UI.
 */
export const AI_CONFIG_KEYS = {
  baseUrl: 'ai_base_url',
  model: 'ai_model',
  apiKey: 'ai_api_key'
} as const

/** Environment fallbacks, in the precedence `resolveGoogleBooksKey` established. */
export const AI_ENV_KEYS = {
  baseUrl: 'MUSAEUM_AI_BASE_URL',
  model: 'MUSAEUM_AI_MODEL',
  apiKey: 'MUSAEUM_AI_API_KEY'
} as const

/**
 * No chunk for this long ends the request.
 *
 * There is deliberately no *total* deadline: a cold local model can legitimately
 * take a minute to produce its first token, and cancelling a request that is
 * about to answer is worse than waiting. Reachable through `AskOptions` so the
 * behaviour is testable without a two-minute test.
 */
const IDLE_TIMEOUT_MS = 120_000

/** Refuse a payload larger than this before it is posted — a runaway passage. */
const MAX_MESSAGE_CHARS = 200_000

/** Which source a resolved value came from — the subset this feature can have. */
type AiSource = Extract<SettingSource, 'configured' | 'env' | 'none'>

interface ResolvedValue {
  value: string | null
  source: AiSource
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** `app_config` wins over the environment, and a blank is never a value. */
function fromConfigOrEnv(configKey: string, envKey: string): ResolvedValue {
  const configured = getConfig(configKey)?.trim()
  if (configured) return { value: configured, source: 'configured' }
  const fromEnv = process.env[envKey]?.trim()
  if (fromEnv) return { value: fromEnv, source: 'env' }
  return { value: null, source: 'none' }
}

export function resolveModel(): ResolvedValue {
  return fromConfigOrEnv(AI_CONFIG_KEYS.model, AI_ENV_KEYS.model)
}

export function resolveKey(): ResolvedValue {
  return fromConfigOrEnv(AI_CONFIG_KEYS.apiKey, AI_ENV_KEYS.apiKey)
}

export interface ResolvedEndpoint {
  value: string
  source: Extract<SettingSource, 'configured' | 'env' | 'default'>
  /**
   * A stored value that is not an http(s) URL, kept so Settings can say so.
   * Re-validated on every read with a failure degrading to the default rather
   * than throwing — the rule `theme_tokens` already follows.
   */
  unusable: string | null
}

export function resolveBaseUrl(): ResolvedEndpoint {
  const configured = getConfig(AI_CONFIG_KEYS.baseUrl)?.trim()
  if (configured && isHttpUrl(configured)) {
    return { value: withoutTrailingSlash(configured), source: 'configured', unusable: null }
  }
  const fromEnv = process.env[AI_ENV_KEYS.baseUrl]?.trim()
  if (fromEnv && isHttpUrl(fromEnv)) {
    return { value: withoutTrailingSlash(fromEnv), source: 'env', unusable: null }
  }
  return { value: DEFAULT_AI_BASE_URL, source: 'default', unusable: configured ?? fromEnv ?? null }
}

export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\/\S+$/.test(value)) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/**
 * Loopback only. A `.local` name resolves to a machine on the LAN and a
 * Tailscale name resolves to one over the internet as far as this app is
 * concerned, so neither counts as local in the sense the disclosure line means.
 */
export function isLoopback(value: string): boolean {
  try {
    const { hostname } = new URL(value)
    return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
  } catch {
    return false
  }
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function hostOf(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

/** What Settings and the panel show about the endpoint, in one place. */
function describeEndpoint(endpoint: ResolvedEndpoint): string {
  const parts: string[] = []
  if (endpoint.unusable) {
    parts.push(`"${endpoint.unusable}" is not an http(s) URL — using the default`)
  } else if (endpoint.source === 'default') {
    parts.push('Default — a local model on this machine')
  }
  parts.push(
    isLoopback(endpoint.value)
      ? 'Local — nothing leaves this machine'
      : `${hostOf(endpoint.value)} receives what you send`
  )
  return parts.join(' · ')
}

function toResolvedSetting(
  value: string | null,
  source: SettingSource,
  detail?: string
): ResolvedSetting {
  return { value, source, detail }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * What the panel needs to decide whether it can work, and what it must say
 * before it sends anything.
 */
export function getStatus(): AiStatus {
  const endpoint = resolveBaseUrl()
  const model = resolveModel()
  const isLocal = isLoopback(endpoint.value)

  return {
    configured: model.value !== null,
    reason: model.value
      ? null
      : 'No model set — add one in Settings (it has to exist on the endpoint).',
    endpoint: toResolvedSetting(endpoint.value, endpoint.source, describeEndpoint(endpoint)),
    model: toResolvedSetting(
      model.value,
      model.source,
      model.value ? `Using ${model.value}` : 'Unset — the ask panel is off'
    ),
    isLocal,
    hasKey: resolveKey().value !== null
  }
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

interface Pending {
  controller: AbortController
  /** True once a terminal event has been broadcast for this id. */
  settled: boolean
}

const pending = new Map<string, Pending>()

export interface AskOptions {
  /** Overridden in tests; the default is `IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number
}

/**
 * Start a streamed request and return as soon as it is in flight. The text
 * arrives as `aiChunk` events and ends with exactly one `aiDone` or `aiError`.
 *
 * Detached on purpose: the caller already has the id (it minted it), so nothing
 * is gained by holding the request open, and a slow local model would otherwise
 * leave an IPC call outstanding for minutes.
 */
export function ask(request: AskRequest, options: AskOptions = {}): { requestId: string } {
  const { requestId, messages } = request
  if (!requestId || typeof requestId !== 'string' || requestId.length > 64) {
    throw new Error('An ask needs a request id of at most 64 characters.')
  }
  if (pending.has(requestId)) throw new Error(`Ask ${requestId} is already in flight.`)
  if (!messages.length) throw new Error('An ask needs at least one message.')

  const chars = messages.reduce((total, message) => total + message.content.length, 0)
  if (chars > MAX_MESSAGE_CHARS) {
    throw new Error(`This request is too large to send (${chars} characters).`)
  }

  const entry: Pending = { controller: new AbortController(), settled: false }
  pending.set(requestId, entry)
  void run(request, entry, options.idleTimeoutMs ?? IDLE_TIMEOUT_MS).finally(() =>
    pending.delete(requestId)
  )
  return { requestId }
}

/**
 * Stop a request. Returns false when it is not in flight — which is also how a
 * settled request reports that it released its slot, so the renderer can tell
 * "cancelled" from "already finished".
 */
export function cancel(requestId: string): boolean {
  const entry = pending.get(requestId)
  if (!entry || entry.settled) return false
  entry.controller.abort()
  return true
}

async function run(request: AskRequest, entry: Pending, idleTimeoutMs: number): Promise<void> {
  const { requestId, messages } = request
  const endpoint = resolveBaseUrl()
  const model = resolveModel()

  if (!model.value) {
    return fail(requestId, entry, 'No model is set — choose one in Settings.')
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream'
  }
  const key = resolveKey().value
  if (key) headers.authorization = `Bearer ${key}`

  let response: Response
  try {
    response = await fetch(`${endpoint.value}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model.value, messages, stream: true }),
      signal: entry.controller.signal
    })
  } catch (err) {
    if (entry.controller.signal.aborted) return done(requestId, entry, 'cancelled')
    return fail(requestId, entry, describeConnectionError(err, endpoint.value))
  }

  if (!response.ok) {
    if (entry.controller.signal.aborted) return done(requestId, entry, 'cancelled')
    return fail(requestId, entry, await describeHttpError(response, endpoint.value, model.value))
  }
  if (!response.body) {
    return fail(
      requestId,
      entry,
      `${endpoint.value} answered without a body — is it an OpenAI-compatible endpoint?`
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  let reason: AskDoneReason | null = null
  let failure: string | null = null
  let idle = false

  /** Returns true when the stream should stop. */
  const consume = (events: SseEvent[]): boolean => {
    for (const event of events) {
      const outcome = readChunk(event.data)
      if (outcome.kind === 'delta') {
        broadcast('aiChunk', { requestId, delta: outcome.text })
      } else if (outcome.kind === 'done') {
        reason = outcome.reason
        return true
      } else if (outcome.kind === 'error') {
        failure = outcome.message
        return true
      }
    }
    return false
  }

  try {
    for (;;) {
      const read = await readBefore(reader, idleTimeoutMs)
      if (read === IDLE) {
        idle = true
        break
      }
      if (read.done) break
      if (consume(parser.push(decoder.decode(read.value, { stream: true })))) break
    }
    // A stream that ends without its final blank line still has one event in
    // the parser — dropping it would drop the last tokens of an answer.
    if (!idle && !failure) consume(parser.flush())
  } catch (err) {
    if (entry.controller.signal.aborted) return done(requestId, entry, 'cancelled')
    failure = describeConnectionError(err, endpoint.value)
  } finally {
    // Releases the socket on every path, including the idle abort. A reader
    // that is already closed rejects, which is not a problem worth reporting.
    void reader.cancel().catch(() => undefined)
  }

  if (failure) return fail(requestId, entry, failure)
  if (idle) {
    entry.controller.abort()
    return done(requestId, entry, 'timeout')
  }
  return done(requestId, entry, reason ?? 'stop')
}

function done(requestId: string, entry: Pending, reason: AskDoneReason): void {
  entry.settled = true
  broadcast('aiDone', { requestId, reason })
}

function fail(requestId: string, entry: Pending, message: string): void {
  entry.settled = true
  broadcast('aiError', { requestId, message })
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** Only ever `message` in practice; carried because the format has it. */
  event: string
  data: string
}

/**
 * An incremental SSE parser: feed it whatever a chunk happens to contain and it
 * returns the events that are complete.
 *
 * Chunk boundaries are not event boundaries — the network routinely splits one
 * event across two reads and packs several into one — which is exactly why this
 * is a separate, tested function instead of four lines inside the read loop.
 */
export function createSseParser(): { push(chunk: string): SseEvent[]; flush(): SseEvent[] } {
  let buffer = ''
  const take = (): SseEvent[] => {
    const events: SseEvent[] = []
    // Normalising the whole buffer each time is safe because it is drained on
    // every push: a `\r` at the end of one chunk and the `\n` that starts the
    // next are only ever adjacent in the accumulating buffer.
    buffer = buffer.replace(/\r\n/g, '\n')
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const event = parseEventBlock(block)
      if (event) events.push(event)
      index = buffer.indexOf('\n\n')
    }
    return events
  }

  return {
    push: (chunk) => {
      buffer += chunk
      return take()
    },
    flush: () => {
      const events = take()
      const tail = parseEventBlock(buffer)
      buffer = ''
      return tail ? [...events, tail] : events
    }
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []

  for (const line of block.split('\n')) {
    // A blank line separates events; a leading colon is a comment, which is
    // what servers send as a keep-alive.
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  return data.length ? { event, data: data.join('\n') } : null
}

export type ChunkOutcome =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; reason: AskDoneReason }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' }

/**
 * One SSE payload, read as an OpenAI-compatible chat chunk.
 *
 * Deliberately forgiving: an unrecognised or malformed line is `ignore`, not a
 * failure. A stream that drops one odd event is still a good answer, and
 * killing it would be the more surprising behaviour.
 */
export function readChunk(data: string): ChunkOutcome {
  const payload = data.trim()
  if (!payload) return { kind: 'ignore' }
  if (payload === '[DONE]') return { kind: 'done', reason: 'stop' }

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { kind: 'ignore' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'ignore' }

  const body = parsed as {
    error?: unknown
    choices?: {
      delta?: { content?: unknown }
      finish_reason?: unknown
    }[]
  }

  const message = errorMessageOf(body.error)
  if (message) return { kind: 'error', message }

  const choice = body.choices?.[0]
  if (!choice) return { kind: 'ignore' }

  // Text first: a chunk that carries both a token and a finish reason is a
  // token, and the reason arrives again on its own. Dropping content to label
  // the ending would be the worse of the two mistakes.
  const content = choice.delta?.content
  if (typeof content === 'string' && content) return { kind: 'delta', text: content }
  if (choice.finish_reason === 'length') return { kind: 'done', reason: 'length' }
  return { kind: 'ignore' }
}

function errorMessageOf(error: unknown): string | null {
  if (typeof error === 'string' && error) return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return null
}

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

/** The errno, reaching through undici's `TypeError: fetch failed` wrapper. */
function errorCode(err: unknown): string | undefined {
  for (const candidate of [(err as { cause?: unknown })?.cause, err]) {
    const code = (candidate as { code?: unknown })?.code
    if (typeof code === 'string') return code
  }
  return undefined
}

/**
 * A diagnosis, not an errno. The Settings surface already refuses to report a
 * path the app does not actually use; telling someone "ECONNREFUSED" about
 * their own machine would be the same failure in a different place.
 */
export function describeConnectionError(err: unknown, endpoint: string): string {
  const code = errorCode(err)
  const host = hostOf(endpoint)
  if (code === 'ECONNREFUSED') {
    return `Nothing is listening at ${endpoint} — is your local model server running?`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not resolve ${host} — check the endpoint in Settings.`
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return `${host} did not answer in time.`
  }
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return `${host}'s certificate could not be verified.`
  }
  const message = err instanceof Error ? err.message : String(err)
  return `Could not reach ${endpoint}: ${message}`
}

/**
 * An HTTP error body's own explanation. A local server that does not have the
 * model answers 400 with `{"error":{"message":"model 'x' not found"}}`, which is
 * the single most useful sentence available — the root object is checked as
 * well, because a few implementations answer `{message}` flat.
 */
function httpErrorMessage(body: string): string | null {
  const parsed = parseJson(body)
  if (typeof parsed === 'string' && parsed) return parsed
  if (parsed && typeof parsed === 'object') {
    return errorMessageOf((parsed as { error?: unknown }).error) ?? errorMessageOf(parsed)
  }
  return null
}

/**
 * An HTTP failure, read for the endpoint's own explanation first.
 */
export async function describeHttpError(
  response: Response,
  endpoint: string,
  model: string | null
): Promise<string> {
  const body = await response.text().catch(() => '')
  const detail = httpErrorMessage(body)

  if (response.status === 401 || response.status === 403) {
    return `The endpoint rejected the key (HTTP ${response.status}).`
  }
  if (response.status === 404) {
    return `No /chat/completions at ${endpoint} — check the endpoint (it usually ends in /v1).`
  }
  if (detail) {
    const about = model ? ` (model ${model})` : ''
    return `${endpoint} answered HTTP ${response.status}${about}: ${detail}`
  }
  const snippet = body.trim().slice(0, 200)
  return `${endpoint} answered HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Reading a stream under an idle deadline
// ---------------------------------------------------------------------------

const IDLE = Symbol('idle')

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

/**
 * `reader.read()` or the deadline, whichever happens first.
 *
 * `Promise.race` attaches its handlers to the read promise, so the read that
 * loses the race — the one still waiting when the deadline fires — rejects into
 * a handled promise when the socket is aborted, not into an unhandled one.
 */
async function readBefore(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number
): Promise<ReadResult | typeof IDLE> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleTimeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
