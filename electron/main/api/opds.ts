import type { BookFilters, BookFormat } from '@shared/book.types'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolveBindAddress, type InterfaceMap } from '../services/api/bind'
import { resolveBookFile, resolveCoverFile } from '../services/book-bytes'
import { getBook, getBooksPage, searchBooksPage, type BookPage } from '../services/db'
import * as nas from '../services/nas-manager'
import { checkBasic, logRejectedOpdsAttempt } from '../services/opds/basic-auth'
import {
  FORMAT_TYPES,
  OPDS_ACQ_TYPE,
  OPDS_NAV_TYPE,
  OPENSEARCH_TYPE,
  buildAcquisitionFeed,
  buildRootFeed,
  buildSearchDescription,
  pageWindow,
  type FeedContext,
  type PageWindow
} from '../services/opds/feed'
import { resolveOpdsConfig, type ResolvedOpdsConfig } from '../services/settings'

/**
 * `api/opds.ts` — the OPDS 1.2 catalog's socket (`docs/superpowers/specs/2026-09-19-opds-catalog-design.md`, slice O1).
 *
 * **Thin by construction (invariant 8), and a deliberate sibling of `api/rest.ts`.**
 * The feed documents are `services/opds/feed.ts` (pure), the credential check is
 * `services/opds/basic-auth.ts` (pure, over the shared constant-time compare),
 * the address is `services/api/bind.ts`, the keys are `services/settings.ts`,
 * the pages are `db.getBooksPage` / `db.searchBooksPage` (no second SQL path,
 * invariant 4), and the path rules are `services/book-bytes.ts` (invariant 9 —
 * the same resolver `musaeum://` and the REST byte routes use). What is left
 * here is wiring: one auth check, one routing switch, one feed writer, one byte
 * writer, and the lifecycle.
 *
 * **The lifecycle is a copy of `rest.ts`'s, on purpose** (amendment A2/A3 and the
 * plan's Architecture note): `activate`, `listenOn`, `closeListener`, the
 * `stopEpoch` race and `describeBindError` are restated one-for-one with
 * `[opds]` and `opds_*` words, rather than extracted, so this slice does not
 * edit a 66 KB file whose contract is the phone's.
 *
 * **Route by route:** `GET /opds` (navigation), `/opds/new`, `/opds/all`,
 * `/opds/search?q=` (acquisition), `/opds/search.xml` (OpenSearch),
 * `/opds/cover/{id}/{thumb|full}` and `/opds/book/{id}/{format}` (bytes).
 * Anything else — an unknown path, or any method but `GET` — is one uniform 404.
 *
 * **Auth runs before routing, for every path.** An unauthenticated request to
 * anything, a path that does not exist included, is a 401: a 404 there would
 * tell a stranger which routes exist.
 *
 * **Never fatal (invariant 12).** A bind failure is a recorded reason, a thrown
 * handler is a 500, an offline share is a 503 on the byte routes only (the feeds
 * answer from SQLite), and a client that hangs up mid-download is a log line.
 */

export type OpdsState = 'disabled' | 'starting' | 'listening' | 'failed'

/** What the socket is doing. Written here, read by the Settings row — never branched on. */
export type OpdsStatus = {
  state: OpdsState
  /** The address bound, or the one the attempt named. Null when disabled. */
  address: string | null
  /** The port bound, or the one the attempt named. Null when disabled. */
  port: number | null
  /** Why it is not listening, in words a Settings row can show. Null when it is. */
  reason: string | null
  /** When the last attempt settled (ISO). Null before the first one. */
  at: string | null
}

let status: OpdsStatus = { state: 'disabled', address: null, port: null, reason: null, at: null }

/** A copy, so a reader cannot decide anything by writing to the report. */
export function getOpdsStatus(): OpdsStatus {
  return { ...status }
}

function record(next: Partial<OpdsStatus>): OpdsStatus {
  status = { ...status, ...next }
  return getOpdsStatus()
}

// ---------------------------------------------------------------------------
// Routes and responses
// ---------------------------------------------------------------------------

const ROOT_ROUTE = '/opds'
const NEW_ROUTE = '/opds/new'
const ALL_ROUTE = '/opds/all'
const SEARCH_ROUTE = '/opds/search'
const SEARCH_DESCRIPTION_ROUTE = '/opds/search.xml'

/** The two orders O1 serves, by the app's own sort fields — `getBooksPage` does the rest. */
const NEW_FILTERS: BookFilters = { sort: { field: 'date_added', direction: 'desc' } }
const ALL_FILTERS: BookFilters = { sort: { field: 'title', direction: 'asc' } }

/**
 * How long a client should wait before retrying a 503 — `rest.ts`'s numbers and
 * reasons: a byte slot frees as soon as a transfer ends, while the share is
 * re-checked on `nas-manager.ts`'s reconnect backoff, whose first step is 5 s.
 */
const BUSY_RETRY_AFTER_SECONDS = 1
const OFFLINE_RETRY_AFTER_SECONDS = 5

/**
 * At most this many byte transfers in flight, covers included.
 *
 * The same bound as `rest.ts`'s `MAX_BYTE_TRANSFERS` and for its reason: the
 * libuv threadpool is four slots for the whole process, a book read off the
 * share is a long-held slot (528 MiB in 25.6 s, measured 2026-09-22), and a
 * stalled mount holds a slot until the kernel gives up. This gate is its own —
 * one per server, beside the REST server's — so the two listeners together can
 * hold at most four, and a misbehaving e-reader cannot starve the app below
 * that. A client that meets the cap gets 503 + `Retry-After`.
 */
const MAX_BYTE_TRANSFERS = 2

/** The text every refusal carries: short, and the same whatever the reason (spec, *Failure semantics*). */
const BODIES = {
  400: 'bad request',
  401: 'unauthorized',
  404: 'not found',
  500: 'internal error',
  busy: 'busy',
  offline: 'library offline',
  noLibrary: 'no library configured'
} as const

/**
 * The one way a text response is written: uncached, and **never a throw** — the
 * guard is the client that hung up mid-answer, as in `rest.ts`'s `sendJson`.
 */
function send(
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {}
): void {
  try {
    res.writeHead(statusCode, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...headers
    })
    res.end(body)
  } catch (err) {
    console.warn(`[opds] could not answer ${statusCode}: ${describeError(err)}`)
    res.destroy()
  }
}

function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  send(res, statusCode, 'text/plain; charset=utf-8', body, headers)
}

/** The exact OPDS media type, plus the charset the documents are written in. */
function sendXml(res: ServerResponse, type: string, xml: string): void {
  send(res, 200, `${type};charset=utf-8`, xml)
}

function sendNotFound(res: ServerResponse): void {
  sendText(res, 404, BODIES[404])
}

function sendUnavailable(res: ServerResponse, kind: 'busy' | 'offline' | 'noLibrary'): void {
  const seconds = kind === 'busy' ? BUSY_RETRY_AFTER_SECONDS : OFFLINE_RETRY_AFTER_SECONDS
  sendText(res, 503, BODIES[kind], { 'retry-after': String(seconds) })
}

function clientAddress(req: IncomingMessage): string | null {
  return req.socket?.remoteAddress ?? null
}

/**
 * The feeds' `http://host:port`, from the address this server is **bound** to.
 *
 * Never the request's `Host` header: a feed is a document a client caches and
 * follows, and a spoofed `Host` written into its links would point every
 * download somewhere else. The only `Host` this rule would accept is one equal
 * to the bound `address:port`, which is the same string built here — so the
 * header is not read at all. IPv6 loopback (`::1`, an allowed bind) is
 * bracketed, as a URL needs it to be.
 */
function boundBaseUrl(server: Server): string {
  const bound = server.address()
  if (!bound || typeof bound === 'string') return 'http://127.0.0.1'
  const host = bound.address.includes(':') ? `[${bound.address}]` : bound.address
  return `http://${host}:${bound.port}`
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

/** The byte budget, as `rest.ts`'s: acquire before a read, release in a `finally`. */
interface ByteGate {
  acquire(): boolean
  release(): void
}

function createByteGate(max: number = MAX_BYTE_TRANSFERS): ByteGate {
  let inFlight = 0
  return {
    acquire: () => {
      if (inFlight >= max) return false
      inFlight += 1
      return true
    },
    // Guarded: a double release would raise the cap silently
    release: () => {
      inFlight = Math.max(0, inFlight - 1)
    }
  }
}

/** A format this catalog advertises — the `FORMAT_TYPES` keys, which are the format union. */
function isFormat(value: string): value is BookFormat {
  return Object.prototype.hasOwnProperty.call(FORMAT_TYPES, value)
}

/**
 * The download's `Content-Disposition`: an ASCII `filename` every client can
 * read, and an RFC 5987 `filename*` for the ones that read UTF-8.
 *
 * The title is the user's metadata, not a filename, so both halves drop what a
 * filename or a header cannot carry — control characters, quotes, slashes and
 * backslashes, which would end the quoted value or name a directory — and the
 * ASCII half also folds accents (`Café` → `Cafe`) and drops whatever else is
 * not printable ASCII. A title that sanitizes to nothing is `book`.
 */
function contentDisposition(title: string, format: BookFormat): string {
  const clean = (text: string): string => {
    let out = ''
    for (const ch of text) {
      const c = ch.codePointAt(0) as number
      // Controls, DEL, lone surrogates, and the characters that break a quoted value or a path
      const drop = c < 0x20 || c === 0x7f || (c >= 0xd800 && c <= 0xdfff) || '"\\/'.includes(ch)
      out += drop ? ' ' : ch
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, 150).trim()
  }

  const unicode = clean(title) || 'book'
  const ascii =
    clean(
      unicode
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, ' ')
    ) || 'book'
  // `encodeURIComponent` leaves `'()*` alone, which RFC 5987's attr-char does not allow
  const encoded = encodeURIComponent(`${unicode}.${format}`).replace(
    /['()*]/g,
    (ch) => `%${(ch.codePointAt(0) as number).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}.${format}"; filename*=UTF-8''${encoded}`
}

interface RouteDeps {
  gate: ByteGate
  openFile: (path: string) => Readable
  baseUrl: () => string
}

/**
 * One file, from the resolver to the socket: always the whole file, always 200
 * (no `Range` — the spec's *Out of scope*), with its length.
 *
 * A file that vanished between the resolver and the `stat` is the uniform 404.
 * A transfer that fails after its headers went out — a client that hung up, a
 * share that went away mid-read — cannot be re-answered, so it is a log line and
 * a dropped socket; `pipeline` destroys the file stream on the way out, and the
 * `finally` gives the slot back (Review Focus 5).
 */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  headers: Record<string, string>,
  deps: RouteDeps
): Promise<void> {
  if (!deps.gate.acquire()) {
    sendUnavailable(res, 'busy')
    return
  }
  try {
    let size: number
    try {
      size = (await fs.stat(path)).size
    } catch {
      sendNotFound(res)
      return
    }
    res.writeHead(200, { ...headers, 'content-length': size, 'cache-control': 'no-store' })
    await pipeline(deps.openFile(path), res)
  } catch (err) {
    console.warn(`[opds] ${req.method} ${req.url} — transfer failed: ${describeError(err)}`)
    res.destroy()
  } finally {
    deps.gate.release()
  }
}

/** `/opds/{kind}/{id}/{last}`, decoded; null for any other shape, or an escape that does not decode. */
function matchBytePath(
  pathname: string
): { kind: 'book' | 'cover'; id: string; last: string } | null {
  const parts = pathname.split('/')
  // ['', 'opds', kind, id, last]
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'opds') return null
  const kind = parts[2]
  if (kind !== 'book' && kind !== 'cover') return null
  try {
    const id = decodeURIComponent(parts[3]!)
    const last = decodeURIComponent(parts[4]!)
    if (!id || !last) return null
    return { kind, id, last }
  } catch {
    return null
  }
}

async function serveBytes(
  req: IncomingMessage,
  res: ServerResponse,
  route: { kind: 'book' | 'cover'; id: string; last: string },
  deps: RouteDeps
): Promise<void> {
  if (route.kind === 'cover' && route.last !== 'thumb' && route.last !== 'full') {
    sendNotFound(res)
    return
  }

  // **The share before the resolver**, as `rest.ts` orders it: an unmounted share
  // must not cost a `readdir`/`realpath` that may hang on a dead SMB mount, and
  // the honest answer is "come back", not "no such book"
  if (!nas.isOnline()) {
    sendUnavailable(res, 'offline')
    return
  }

  if (route.kind === 'cover') {
    const cover = await resolveCoverFile(route.id, route.last)
    // The resolver's 400 (a traversing row) is folded into the uniform 404 here:
    // the spec's failure table names no reason a client may learn
    if (!cover.ok) {
      sendNotFound(res)
      return
    }
    await sendFile(req, res, cover.path, { 'content-type': 'image/jpeg' }, deps)
    return
  }

  const format = route.last
  // Unknown format, a format the book lacks, an unknown book, a traversing
  // `nasPath` and a missing file are one answer (the resolver's `null`)
  const path = isFormat(format) ? await resolveBookFile(route.id, format) : null
  if (!path || !isFormat(format)) {
    sendNotFound(res)
    return
  }
  const title = getBook(route.id)?.title ?? ''
  await sendFile(
    req,
    res,
    path,
    {
      // The feed's own table, so a link's `type` and the bytes' label agree (azw3 included)
      'content-type': FORMAT_TYPES[format],
      'content-disposition': contentDisposition(title, format)
    },
    deps
  )
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

/**
 * One acquisition page: validate `?page=`, query, build.
 *
 * `pageWindow` is asked twice — once to validate and size the query (the total
 * is not known yet, and `offset`/`limit` do not depend on it), once with the
 * query's total for the `next`/`previous` links. An absent `page` is page 1, a
 * present-but-invalid one is 400 (never an `OFFSET` of NaN), and a page past the
 * end is a 200 with no entries.
 */
function serveAcquisition(
  res: ServerResponse,
  url: URL,
  ctx: FeedContext,
  feed: { id: string; title: string; selfPath: string },
  query: (window: PageWindow) => BookPage
): void {
  const rawPage = url.searchParams.get('page')
  const probe = pageWindow(rawPage, 0)
  if (!probe) {
    sendText(res, 400, BODIES[400])
    return
  }
  const page = query(probe)
  const window = pageWindow(rawPage, page.total) as PageWindow
  sendXml(
    res,
    OPDS_ACQ_TYPE,
    buildAcquisitionFeed(ctx, { ...feed, books: page.books, total: page.total, window })
  )
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedOpdsConfig,
  deps: RouteDeps
): Promise<void> {
  try {
    // First, for every path and every method: nothing below runs unauthenticated
    const auth = checkBasic(req.headers.authorization, config.token)
    if (!auth.ok) {
      logRejectedOpdsAttempt(clientAddress(req))
      sendText(res, 401, BODIES[401], { 'www-authenticate': 'Basic realm="Musaeum"' })
      return
    }

    if (req.method !== 'GET') {
      sendNotFound(res)
      return
    }

    // A placeholder base that never resolves anything; links use `deps.baseUrl`
    const url = new URL(req.url ?? '/', 'http://musaeum.invalid')
    const ctx: FeedContext = { baseUrl: deps.baseUrl(), now: new Date().toISOString() }

    switch (url.pathname) {
      case ROOT_ROUTE:
        // No library yet: "server busy" rather than an empty catalog a client caches
        if (!nas.getLibraryRoot()) {
          sendUnavailable(res, 'noLibrary')
          return
        }
        sendXml(res, OPDS_NAV_TYPE, buildRootFeed(ctx))
        return

      case NEW_ROUTE:
        serveAcquisition(
          res,
          url,
          ctx,
          { id: 'urn:musaeum:opds:new', title: 'Newest', selfPath: NEW_ROUTE },
          (w) => getBooksPage(NEW_FILTERS, { limit: w.limit, offset: w.offset })
        )
        return

      case ALL_ROUTE:
        serveAcquisition(
          res,
          url,
          ctx,
          { id: 'urn:musaeum:opds:all', title: 'All books', selfPath: ALL_ROUTE },
          (w) => getBooksPage(ALL_FILTERS, { limit: w.limit, offset: w.offset })
        )
        return

      case SEARCH_ROUTE: {
        // The app's own FTS path, relevance-ordered. A query with no terms (blank,
        // or only quotes) is not an empty catalog: `searchBooksPage` itself answers
        // it with the library in its default order, which is title ascending —
        // the `all` feed's order (Review Focus 2)
        const q = url.searchParams.get('q') ?? ''
        serveAcquisition(
          res,
          url,
          ctx,
          {
            id: 'urn:musaeum:opds:search',
            title: q.trim() ? `Search: ${q}` : 'All books',
            selfPath: `${SEARCH_ROUTE}?q=${encodeURIComponent(q)}`
          },
          (w) =>
            q.trim()
              ? searchBooksPage(q, { limit: w.limit, offset: w.offset })
              : getBooksPage(ALL_FILTERS, { limit: w.limit, offset: w.offset })
        )
        return
      }

      case SEARCH_DESCRIPTION_ROUTE:
        sendXml(res, OPENSEARCH_TYPE, buildSearchDescription(ctx))
        return
    }

    const bytes = matchBytePath(url.pathname)
    if (bytes) {
      await serveBytes(req, res, bytes, deps)
      return
    }

    sendNotFound(res)
  } catch (err) {
    // Never a throw out of a request (invariant 12): a 500, and the next request is served
    console.warn(`[opds] request failed: ${describeError(err)}`)
    sendText(res, 500, BODIES[500])
  }
}

/** What a case may change about the server it asks for. */
export interface OpdsServerOptions {
  /** The feeds' link base. Default: the address the server is bound to, read per request. */
  baseUrl?: string
  /**
   * How a file's bytes are opened. Default `fs.createReadStream`. The seam lets a
   * case watch the stream close on a hang-up, and hold a transfer open to decide
   * the byte cap without a slow disk — `rest.ts`'s `transfer` seam's reason.
   */
  openFile?: (path: string) => Readable
}

/**
 * The server, wired but not listening (the test seam, as `createRestApiServer`):
 * a case drives the real handler over a real socket on an ephemeral port.
 */
export function createOpdsServer(
  config: ResolvedOpdsConfig,
  options: OpdsServerOptions = {}
): Server {
  // One gate per server, created here so it outlives a request
  const deps: RouteDeps = {
    gate: createByteGate(),
    openFile: options.openFile ?? ((path) => createReadStream(path)),
    baseUrl: () => options.baseUrl ?? boundBaseUrl(server)
  }
  const server = createServer((req, res) => {
    // A socket-level failure on one request must not surface as an unhandled
    // 'error' on these objects, which would take the process down (invariant 12)
    req.on('error', () => undefined)
    res.on('error', () => undefined)
    void handleRequest(req, res, config, deps)
  })
  return server
}

// ---------------------------------------------------------------------------
// The lifecycle — `rest.ts`'s, restated (see the header)
// ---------------------------------------------------------------------------

/** What a listen attempt settled as. Never a throw — the caller records it. */
export type ListenOutcome =
  { ok: true; address: string; port: number } | { ok: false; message: string }

/** How the server is put on the wire; a seam so a case can assert that no listen was attempted. */
export type ListenFn = (server: Server, host: string, port: number) => Promise<ListenOutcome>

/**
 * Listen, and report. The `'error'` listener stays attached for the server's
 * whole life, because an unhandled `'error'` on a listening server takes the
 * process down.
 */
async function listenOn(server: Server, host: string, port: number): Promise<ListenOutcome> {
  let settle: (outcome: ListenOutcome) => void = () => undefined
  const settled = new Promise<ListenOutcome>((resolve) => {
    settle = resolve
  })

  server.on('error', (err) => {
    const message = describeBindError(err, host, port)
    console.warn(`[opds] ${message}`)
    settle({ ok: false, message })
  })

  server.listen({ host, port }, () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      settle({ ok: false, message: `the server answered no address for ${host}:${port}` })
      return
    }
    settle({ ok: true, address: address.address, port: address.port })
  })

  return await settled
}

/** The listener activation opened; assigned only on a successful listen. Null means nothing of ours is on the wire. */
let openServer: Server | null = null

/**
 * What activation reads from outside itself. **No case may bind this machine's
 * real tailnet address**, and none may read the dev profile's config.
 */
export interface StartOptions {
  /** Default: `resolveOpdsConfig()` — the four `opds_*` keys. */
  config?: ResolvedOpdsConfig
  /** Default: `os.networkInterfaces()`. */
  interfaces?: InterfaceMap
  /** Default: `listenOn` — a real `node:http` listener. */
  listen?: ListenFn
}

/**
 * Activate the catalog if the flag says so, and report what happened. Resolves
 * with the recorded status and **never throws** — the call site is `void
 * startOpdsIfEnabled()` at start-up, and `resolveOpdsConfig()` reads a database
 * that opens lazily (invariant 12).
 */
export async function startOpdsIfEnabled(options: StartOptions = {}): Promise<OpdsStatus> {
  try {
    return await activate(options)
  } catch (err) {
    return fail(`activation failed — ${describeError(err)}`)
  }
}

/**
 * The resolver words its refusals for the REST key (`rest_api_bind`). The OPDS
 * row must name its own key, or the owner is told to edit the wrong setting.
 */
function opdsBindReason(reason: string | null): string {
  return (reason ?? 'no address to bind').replaceAll('rest_api_bind', 'opds_bind')
}

async function activate(options: StartOptions): Promise<OpdsStatus> {
  const config = options.config ?? resolveOpdsConfig()
  // Captured before the `await` below: a stop arriving mid-bind moves it
  const epoch = stopEpoch

  if (!config.enabled) {
    // Nothing is created at all — no server, no socket, no listen attempt (AC2.13)
    return record({ state: 'disabled', address: null, port: null, reason: null, at: null })
  }

  if (!config.token) {
    // Fail closed: Settings generates the token on enable, so this is a hand-edited row
    return fail(
      'opds_enabled is on but opds_token is empty — enable the catalog from Settings to generate one'
    )
  }

  const decision = resolveBindAddress(options.interfaces ?? networkInterfaces(), config.bind)
  if (!decision.ok || !decision.address) {
    // No bind is attempted at all, which is the whole content of the refusal
    return fail(opdsBindReason(decision.reason))
  }

  record({
    state: 'starting',
    address: decision.address,
    port: config.port,
    reason: null,
    at: new Date().toISOString()
  })

  const server = createOpdsServer(config)
  const outcome = await (options.listen ?? listenOn)(server, decision.address, config.port)

  if (!outcome.ok) return fail(outcome.message, decision.address, config.port)

  // **A stop that arrived while we were binding wins** — otherwise the socket
  // opens after the stop reported success, with nothing holding it to close
  if (epoch !== stopEpoch) {
    await closeListener(server)
    return record({
      state: 'disabled',
      address: null,
      port: null,
      reason: null,
      at: new Date().toISOString()
    })
  }

  openServer = server

  return record({
    state: 'listening',
    address: outcome.address,
    port: outcome.port,
    reason: null,
    at: new Date().toISOString()
  })
}

/** Bumped by every stop; an activation in flight when it moved has been canceled. */
let stopEpoch = 0

/**
 * Close a listener, dropping its connections (a download in flight must not
 * outlive a stop the owner asked for). Never throws. The `!listening` guard
 * keeps `ERR_SERVER_NOT_RUNNING` — the `listen` seam's shape — from turning a
 * successful activation's status into a failure.
 */
async function closeListener(server: Server): Promise<string | null> {
  if (!server.listening) return null
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
      server.closeAllConnections()
    })
    return null
  } catch (err) {
    return describeError(err)
  }
}

/**
 * Close the listener activation opened, and report what is left behind.
 * Idempotent and never fatal: stopping what was never started, or stopping
 * twice, is a settled no-op — the caller is a switch.
 */
export async function stopOpds(): Promise<OpdsStatus> {
  // First, so an activation mid-bind learns it lost
  stopEpoch += 1

  const server = openServer
  openServer = null

  const stopped = (): OpdsStatus =>
    record({
      state: 'disabled',
      address: null,
      port: null,
      reason: null,
      at: new Date().toISOString()
    })

  if (!server) return stopped()

  const bound = server.address()
  const where =
    bound && typeof bound !== 'string' ? { address: bound.address, port: bound.port } : null

  const failure = await closeListener(server)
  if (failure) {
    // The socket may still be live: keep the reference and say `failed`, never
    // `disabled` — `rest.ts`'s belt-and-braces branch, for the same reason
    openServer = server
    return record({
      state: 'failed',
      address: where?.address ?? null,
      port: where?.port ?? null,
      reason: `could not close the listener — ${failure}`,
      at: new Date().toISOString()
    })
  }

  return stopped()
}

function fail(
  reason: string,
  address: string | null = null,
  port: number | null = null
): OpdsStatus {
  console.warn(`[opds] not listening — ${reason}`)
  return record({ state: 'failed', address, port, reason, at: new Date().toISOString() })
}

/** The errno, when Node gave us one. */
function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : null
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = errorCode(err)
  return code ? `${message} (${code})` : message
}

/** A bind failure in the words the Settings row can show — `rest.ts`'s three, restated. */
function describeBindError(err: unknown, host: string, port: number): string {
  const code = errorCode(err)
  if (code === 'EADDRINUSE') return `port ${port} is already in use on ${host} (EADDRINUSE)`
  if (code === 'EADDRNOTAVAIL') return `${host} is not an address on this machine (EADDRNOTAVAIL)`
  if (code === 'EACCES') return `the system refused a listener on ${port} (EACCES)`
  return describeError(err)
}
