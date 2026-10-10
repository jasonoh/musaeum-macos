import { reflowAvailable } from '@shared/book.types'
import { app } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { checkBearer, logRejectedAttempt } from '../services/api/auth'
import { resolveBindAddress, type InterfaceMap } from '../services/api/bind'
import { parseLibraryQuery, parseShelfParam } from '../services/api/query'
import { applyReadingReport, parseReadingReport } from '../services/api/reading'
import {
  isBooksCollection,
  matchBookPath,
  matchShelfMembershipPath,
  refusalError,
  type ShelfBookPath
} from '../services/api/routes'
import {
  bookPayload,
  cannotReflowPayload,
  errorPayload,
  facetsPayload,
  healthPayload,
  importPayload,
  libraryPayload,
  membershipPayload,
  readingPayload,
  reflowPendingPayload,
  shelvesPayload,
  type ApiError
} from '../services/api/shape'
import { receiveUpload, type UploadOptions, type UploadRefusal } from '../services/api/upload'
import {
  parseByteRange,
  resolveBookFile,
  resolveCoverFile,
  resolveReflowFile,
  bookContentType
} from '../services/book-bytes'
import {
  bookExists,
  countBooks,
  getBook,
  getBooksPage,
  getFacets,
  listShelvesWithUpdatedAt,
  searchBooksPage,
  shelfExists,
  shelfIdsForBooks
} from '../services/db'
import * as nas from '../services/nas-manager'
import * as reflow from '../services/reflow'
import { addBooks, isShelfGone, removeBooks } from '../services/shelves'
import { resolveRestApiConfig, type ResolvedRestApiConfig } from '../services/settings'

/**
 * `api/rest.ts` — the JSON API's socket: the read surface, and the report of
 * what it did.
 *
 * **Thin by construction (invariant 8).** Every decision this surface needs is
 * made elsewhere, and made testable without a socket: which address may be
 * bound is `services/api/bind.ts` (a pure function over an interface map), which
 * port and whether the flag is on are `services/settings.ts` (with validation
 * before write), whether a request is allowed is `services/api/auth.ts` (a
 * constant-time comparison), what a payload looks like is
 * `services/api/shape.ts` (the contract's field names, and the numbers a page
 * may be), the library route's parameters are `services/api/query.ts` and the
 * book paths and refusal words are `services/api/routes.ts` (both pure over a
 * `URL` or a path), the reading write's rules are `services/api/reading.ts` (which
 * is `services/reading-state.ts`'s `saveProgress` and nothing else), the shelf
 * writes' funnel is `services/shelves.ts` (its rules are D3's), the
 * queries are `services/db.ts` (one WHERE body, one `ORDER BY`, paging
 * appended), the path and range rules are `services/book-bytes.ts`, and the
 * bytes come from the NAS. What is left here is wiring — one routing switch, one
 * auth check, one JSON writer, one byte writer — which is the OPDS spec's D7
 * shape reused rather than re-derived (`2026-09-19-opds-catalog-design.md`). No
 * new dependency: `node:http` is Node, and the main process is Node.
 *
 * **The parameter and path decisions used to live here**, reachable only
 * through a live socket. D2's own test is "anything that can be a pure function
 * of inputs becomes one so the suite can decide it without a socket", and the
 * pre-merge review handed that split to slice 1c: `services/api/query.ts` and
 * `services/api/routes.ts` hold the six moved functions and their socketless
 * cases, while the byte gate, the transfer, the status record and the auth
 * check stay — those write headers and own the transfer budget, which is HTTP's
 * own business.
 *
 * **The status record below is a reporter, not business logic.** It is the one
 * thing only this module can know — what its own socket did — and it decides
 * nothing: the address, the port, the token and whether to start at all are all
 * settled in `services/`. Slice 2's Settings row reads it through a thin IPC
 * handler (`getRestApiStatus`), which is why it lives here rather than in
 * `services/`: nothing else would be reporting its own side effect. The byte
 * gate is the same kind of thing — the state of this module's own transfers.
 *
 * **Route by route (docs/rest-api.md is the contract; this is the wiring):**
 * `GET /api/health`, `GET /api/library`, `GET /api/library/facets`,
 * `GET /api/shelves`, `GET /api/books/{id}`, `GET /api/books/{id}/cover`,
 * `GET /api/books/{id}/file`, `PUT /api/books/{id}/reading` — slice 1c's, which
 * reads a JSON body — `POST /api/books`, which takes a book's bytes as its body
 * (the phone-upload design, D1), and the bookshelves slice's membership pair,
 * `PUT`/`DELETE /api/shelves/{id}/books/{bookId}`, which send no body at all.
 *
 * **Never fatal (invariant 12, D11).** A bind failure is logged, recorded and
 * the app starts normally; a thrown handler answers 500; a failed read is 404, a
 * stalled share is 503, an exhausted byte budget is 503 + `Retry-After`, and a
 * client that hung up mid-transfer is a log line. No path in this module throws
 * out of `app.whenReady` or out of a request.
 */

/**
 * `/api/health` — the client's connect check (D12).
 *
 * The library routes are matched by these three constants and the book paths by
 * `services/api/routes.ts`'s matcher: an unmatched path answers 404 uniformly
 * and reason-free (D11), and a known path behind the wrong method is not
 * distinguished from no path at all.
 */
const HEALTH_ROUTE = '/api/health'
const LIBRARY_ROUTE = '/api/library'
const FACETS_ROUTE = '/api/library/facets'
const SHELVES_ROUTE = '/api/shelves'

/** One book's shelf ids, through the same batched read the page uses (bookshelves D10, S7). */
function shelfIdsFor(bookId: string): string[] {
  return shelfIdsForBooks([bookId]).get(bookId) ?? []
}

export type RestApiState = 'disabled' | 'starting' | 'listening' | 'failed'

/**
 * What the socket is doing. Written by this module, read by the log here and by
 * slice 2's Settings row — never branched on.
 */
export interface RestApiStatus {
  state: RestApiState
  /** The address bound, or the one the attempt named. Null when disabled. */
  address: string | null
  /** The port bound, or the one the attempt named. Null when disabled. */
  port: number | null
  /** Why it is not listening, in words a Settings row can show. Null when it is. */
  reason: string | null
  /** When the last attempt settled (ISO). Null before the first one. */
  at: string | null
}

let status: RestApiStatus = { state: 'disabled', address: null, port: null, reason: null, at: null }

/** A copy, so a reader cannot decide anything by writing to the report. */
export function getRestApiStatus(): RestApiStatus {
  return { ...status }
}

function record(next: Partial<RestApiStatus>): RestApiStatus {
  status = { ...status, ...next }
  return getRestApiStatus()
}

/**
 * The one way a JSON response is written: uncached, and **never a throw**.
 *
 * `cache-control: no-store` because health answers "where is the server now",
 * and a cached one is a wrong one — the lesson the cover URLs already learned.
 * The guard is the client that hung up mid-answer: there is nobody left to
 * answer, and a throw here would leave a rejected promise where invariant 12
 * wants a log line. The same guard covers a second `writeHead` on a response
 * that has already started, which is the shape a failure *after* a byte route
 * began streaming would take.
 *
 * A `HEAD` request reaches here unchanged and `node:http` drops the body while
 * keeping these headers — which is exactly what a probe wants, and the reason
 * the JSON routes accept `HEAD` at all (see the method policy in the router).
 */
function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...headers
    })
    res.end(body)
  } catch (err) {
    console.warn(`[rest] could not answer ${statusCode}: ${describeError(err)}`)
    res.destroy()
  }
}

function clientAddress(req: IncomingMessage): string | null {
  return req.socket?.remoteAddress ?? null
}

// ---------------------------------------------------------------------------
// Bytes (D9, D15)
// ---------------------------------------------------------------------------

/**
 * How long a client should wait before retrying a 503.
 *
 * The two 503s are different waits, and the numbers are read off this repo
 * rather than picked: the byte budget frees as soon as a transfer ends — the
 * largest book in this library reads whole in 25.6 s, and a cover page's reads
 * are ~50 ms each, so a second is generous — while the share is re-checked on
 * `services/nas-manager.ts`'s own reconnect backoff, whose first step is 5 s.
 */
const BUSY_RETRY_AFTER_SECONDS = 1
const OFFLINE_RETRY_AFTER_SECONDS = 5

/**
 * At most this many byte transfers in flight (D9).
 *
 * **Why a cap at all:** the default libuv threadpool is four slots for the whole
 * process, and the app's own cover loads, catalog writes and hydration reads
 * share them. Measured on this machine on 2026-09-22, the largest EPUB on the
 * share is 554,110,279 bytes (528 MiB) and reads whole in **25.64 s** at ~20.6
 * MiB/s with almost no CPU — so a transfer is a *long-held* slot, not a burst,
 * which is the reading `tasks.md:110` warns about (`fs.readdir` on a stalled
 * share holds a threadpool slot). Two is chosen to leave the app slots to work
 * with; it is a bound to revisit with a measurement under load, not a law.
 *
 * **It covers both byte routes, covers included.** A cover read is ~50 ms and
 * 60 of them are a grid page, but each still holds a slot, and the stalled-mount
 * case is precisely what the number is for. The consequence for the client — two
 * covers at a time, `503` retryable — is stated in `docs/rest-api.md` rather
 * than left for the client to discover.
 */
const MAX_BYTE_TRANSFERS = 2

/**
 * How one byte transfer's body is written: the bytes of `path` from `start` to
 * `end` (**inclusive**) onto `res`, whose status line and headers the caller has
 * already set. Nothing here writes a header; nothing here decides a status.
 */
export type ByteTransfer = (
  path: string,
  start: number,
  end: number,
  res: ServerResponse
) => Promise<void>

/**
 * The default transfer: streamed, never buffered.
 *
 * The largest EPUB in this library is 528 MiB, so `readFile` would put half a
 * gigabyte in the main process's heap and bound memory by the library's worst
 * book rather than by the socket buffer. `pipeline` also closes the stream when
 * the client goes away, which is what makes a hung-up download a log line.
 *
 * **A stalled read is bounded by the kernel, not by a timer here.** A dropped
 * SMB mount does not fail a read quickly — the libuv request sits in its
 * threadpool slot until the OS times the I/O out (macOS's SMB client can take
 * minutes) — so this stream holds its slot for as long as the share is wedged.
 * That is exactly the exposure the cap above bounds to two slots rather than to
 * however many covers a phone asks for; a per-transfer timeout is the next step
 * if the cap alone proves too coarse, and it is deliberately not guessed at here.
 */
async function streamRange(
  path: string,
  start: number,
  end: number,
  res: ServerResponse
): Promise<void> {
  await pipeline(createReadStream(path, { start, end }), res)
}

/**
 * The byte budget. Acquire before a read starts, release in a `finally`, so a
 * failure and a client that hung up both give the slot back.
 */
interface ByteGate {
  /** True when a slot was taken; false means the caller answers 503 (D9). */
  acquire(): boolean
  release(): void
}

/**
 * One gate per server, and one server per process (`startRestApiIfEnabled` runs
 * once inside `app.whenReady`), so this is the process-wide cap the spec names.
 */
function createByteGate(max: number = MAX_BYTE_TRANSFERS): ByteGate {
  let inFlight = 0
  return {
    acquire: () => {
      if (inFlight >= max) return false
      inFlight += 1
      return true
    },
    release: () => {
      // Guarded rather than trusted: a double release would raise the cap
      // silently, which is worse than a count that is merely wrong
      inFlight = Math.max(0, inFlight - 1)
    }
  }
}

/** What a route reads from outside itself. The transfer is a seam so a case can hold one open (AC17). */
interface RouteDeps {
  transfer: ByteTransfer
  gate: ByteGate
  /** How long a request body has to arrive before it is refused. */
  bodyTimeoutMs: number
  /**
   * How the upload route's body is bounded, and where its scratch file lands.
   * An `UploadOptions` rather than three fields: `services/api/upload.ts`
   * already owns the cap, the stall clock and the scratch directory, and the
   * route passes them through untouched (`ServerOptions.upload` is the seam).
   */
  upload: UploadOptions
}

/** A file to serve, and the type its bytes are labelled with. */
interface ByteSource {
  path: string
  contentType: string
  /** Send an `ETag` derived from the same stat the bytes are served by (the reflow route). */
  etag?: boolean
}

/** The 503s, which differ only in their wait and their word. */
function sendUnavailable(res: ServerResponse, kind: 'busy' | 'offline'): void {
  const seconds = kind === 'busy' ? BUSY_RETRY_AFTER_SECONDS : OFFLINE_RETRY_AFTER_SECONDS
  sendJson(res, 503, errorPayload(kind), { 'retry-after': String(seconds) })
}

/**
 * One file, from the resolver to the socket.
 *
 * The status table is D11's: **416** for a range this file cannot satisfy,
 * **404** for a file that vanished between the resolver's `realpath` and this
 * read, **503** for a transfer that cannot start because the byte budget is
 * spent, and **200/206** otherwise. A transfer that fails *after* its headers
 * went out cannot be re-answered — the status was already written — so it is
 * logged and the socket is dropped (invariant 12: never a throw, never a 500
 * pretending the response had not started).
 */
async function sendBytes(
  req: IncomingMessage,
  res: ServerResponse,
  source: ByteSource,
  deps: RouteDeps
): Promise<void> {
  if (!deps.gate.acquire()) {
    sendUnavailable(res, 'busy')
    return
  }

  try {
    let size: number
    let etag: string | undefined
    try {
      const stat = await fs.stat(source.path)
      size = stat.size
      if (source.etag) etag = `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`
    } catch {
      sendJson(res, 404, errorPayload('notFound'))
      return
    }

    const shared = {
      'content-type': source.contentType,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      ...(etag ? { etag } : {})
    }

    // **The range is decided before the empty-file branch, because the two interact.**
    // Any `Range` against a 0-byte file is unsatisfiable — `parseByteRange`'s own rule,
    // and `bytes=<total>-` in `docs/rest-api.md`'s table — so a resuming client is told
    // the length is 0 rather than handed an empty 200 that reads as a finished download.
    const range = parseByteRange(req.headers.range, size)
    if (range.kind === 'unsatisfiable') {
      // `Content-Range: bytes */<size>` is what tells a resuming client how long
      // the file actually is, which is the whole point of the 416 (RFC 9110)
      sendJson(res, 416, errorPayload('rangeNotSatisfiable'), {
        'content-range': `bytes */${size}`,
        'accept-ranges': 'bytes'
      })
      return
    }

    if (size === 0) {
      // A 0-byte file with no `Range` is still a 200 with no body: not a book or a
      // cover this app writes, but the arithmetic below would ask for `-1` bytes and
      // throw. Reachable through a half-failed write, which is why it has a case.
      res.writeHead(200, { ...shared, 'content-length': 0 })
      res.end()
      return
    }

    const start = range.kind === 'partial' ? range.start : 0
    const end = range.kind === 'partial' ? range.end : size - 1

    res.writeHead(range.kind === 'partial' ? 206 : 200, {
      ...shared,
      'content-length': end - start + 1,
      ...(range.kind === 'partial' ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
    })

    await deps.transfer(source.path, start, end, res)
  } catch (err) {
    // A client that hung up, or a share that went away mid-read. The status was
    // already written, so this is a log line and a dropped socket — the request
    // never throws and the process keeps serving (invariant 12).
    console.warn(`[rest] ${req.method} ${req.url} — transfer failed: ${describeError(err)}`)
    res.destroy()
  } finally {
    deps.gate.release()
  }
}

// ---------------------------------------------------------------------------
// The reflow route (PDF-reflow slice 4, D8)
// ---------------------------------------------------------------------------

/**
 * How long a `format=reflow` request waits for the pass before answering 202. A
 * cached artifact, or a quick pass, is served in the same request; a long one is
 * polled. The pass is never cancelled by the window closing.
 */
export const REFLOW_GRACE_MS = 2000

/**
 * `GET /api/books/{id}/file?format=reflow` — a PDF-only book's reflowed EPUB.
 *
 * Order matters: eligibility (404), a running pass (202, joined never doubled),
 * a remembered refusal (422, no new pass), then start-or-join the pass and race
 * it against the grace window. A 202 holds no byte-gate slot — only `sendBytes`
 * acquires one. The offline 503 was answered by the caller.
 */
async function serveReflow(
  req: IncomingMessage,
  res: ServerResponse,
  bookId: string,
  deps: RouteDeps
): Promise<void> {
  const found = getBook(bookId)
  if (!found || !reflowAvailable(found)) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }

  const running = reflow.wireStatus(bookId)
  if (running) {
    sendJson(res, 202, reflowPendingPayload(running), { 'retry-after': '2' })
    return
  }

  const refused = reflow.recentRefusal(bookId)
  if (refused !== null) {
    sendJson(res, 422, cannotReflowPayload(refused))
    return
  }

  // The PDF must resolve before any pass starts, so a traversing row or a
  // missing file is the uniform 404 and not a 422 with a reason (D11).
  if (!(await resolveBookFile(bookId, 'pdf'))) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }

  const pass = reflow.ensure(bookId)
  // Attached before the race: a pass that rejects after the grace window has
  // closed must not surface as an unhandled rejection (invariant 12).
  pass.catch(() => {})

  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REFLOW_GRACE_MS)
  })
  let winner
  try {
    winner = await Promise.race([
      pass.then(
        (result) => result,
        (err: unknown) => ({ status: 'error' as const, error: err })
      ),
      grace
    ])
  } finally {
    clearTimeout(timer)
  }

  // The share may have dropped while the pass ran: that is the offline 503,
  // whatever the pass came to.
  if (!nas.isOnline()) {
    sendUnavailable(res, 'offline')
    return
  }

  if (winner === null) {
    sendJson(
      res,
      202,
      reflowPendingPayload(reflow.wireStatus(bookId) ?? { phase: 'start', completed: 0, total: 0 }),
      { 'retry-after': '2' }
    )
    return
  }
  if (winner.status === 'error') {
    // Pre-flight (no sidecar, no PDF file): this module's own failure, logged
    // where a person can read it. The message is the filesystem's or the
    // runtime's and never goes on the wire (invariant 12).
    console.warn(`[rest] reflow for ${bookId} failed: ${describeError(winner.error)}`)
    sendJson(res, 500, errorPayload('internal'))
    return
  }
  if (winner.status === 'fallback') {
    sendJson(res, 422, cannotReflowPayload(winner.reason))
    return
  }

  const path = await resolveReflowFile(bookId)
  if (!path) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }
  await sendBytes(req, res, { path, contentType: bookContentType('epub'), etag: true }, deps)
}

// ---------------------------------------------------------------------------
// The write: the reading-progress report (D4, D5, D6)
// ---------------------------------------------------------------------------

/**
 * The largest body this route will read.
 *
 * A report is `{"percent":0.42,"at":"2026-09-22T09:12:00.000Z"}` — under 60
 * bytes. The cap exists because the alternative is a network surface that
 * buffers whatever it is handed: the router runs in the main process, the same
 * one holding the library, and the byte routes' own budget (D9) is the same
 * instinct one level up. 4 KB is two orders of magnitude of headroom, so the
 * only request it refuses is one that was never a report.
 */
const MAX_BODY_BYTES = 4096

/**
 * How long a request body has to arrive.
 *
 * The answer's only bound that does not belong to the client. A client that
 * declares a `Content-Length` larger than what it sends never emits `end`, and a
 * reader that waits for one waits forever — measured 2026-09-22 (pre-merge
 * review, finding 6): a declared `Content-Length: 100` with a 6-byte body got
 * **no response and no server-side close in 8 s**, so the request was never
 * answered at all, which is a worse failure than any refusal. Generous, because
 * the honest case is a few hundred bytes over a tailnet; a seam, because a case
 * should not have to wait ten seconds to decide it.
 */
const BODY_TIMEOUT_MS = 10_000

/**
 * One request body, as JSON. **Never throws** (invariant 12): a body that is
 * not JSON, and a body larger than the cap, are both "a request this route
 * cannot make sense of" — the 400 the read routes answer for a malformed
 * parameter, and never a 500 for the client's own mistake.
 *
 * **The overflow case keeps reading and discards.** Breaking out of the stream
 * early would destroy the socket and answer the client a reset instead of a
 * 400, so the body is drained (chunks after the cap are dropped rather than
 * kept) and the answer is decided at `end` — which also means a body larger
 * than the cap costs memory bounded by the cap, not by the body. A client that
 * never sends `end` is bounded by `BODY_TIMEOUT_MS` — the socket's own timeouts
 * do **not** bound it, which was the claim here until it was measured: a client
 * that lies about `Content-Length` left the request unanswered for as long as
 * anyone watched (finding 6, 2026-09-22). The timer is the whole difference.
 *
 * `Content-Type` is deliberately **not** enforced: nothing in this surface
 * reads one, the byte routes have no equivalent check, and a client that sent
 * JSON without the header would get a refusal it could not act on.
 */
function readJsonBody(
  req: IncomingMessage,
  timeoutMs: number
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    let settled = false

    /** One answer per request, whichever of the three arrives first. */
    const finish = (result: { ok: true; body: unknown } | { ok: false }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false }), timeoutMs)

    const onData = (chunk: Buffer): void => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    }

    const onEnd = (): void => {
      if (tooLarge || !size) {
        finish({ ok: false })
        return
      }
      try {
        finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false })
      }
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', () => finish({ ok: false }))
  })
}

/**
 * `PUT /api/books/{id}/reading` — the reading write, and the only place in this
 * module that changes a book's reading state (D4).
 *
 * **The order is the contract's.** The body is validated before the book is
 * looked up, which is the same order the cover route validates `size` in and
 * the reason a malformed report answers 400 rather than 404 even for an id
 * that does not exist: a request this surface cannot parse is refused before
 * it is anything else. Then the write — `applyReadingReport`, which is
 * `services/reading-state.ts`'s `saveProgress` under a 400 table, an unknown
 * book being the only thing it answers 404 for.
 *
 * The three answers are D11's: **400** for a body this route cannot make sense
 * of (not JSON, too large, a `percent` that is not a number in 0–1, an `at`
 * that is not a timestamp), **404** for an unknown book, **200** with
 * `{ applied, book }` otherwise — `applied: false` when the report was older
 * than the row's own clock (D6), in which case nothing was written at all.
 */
async function handleReadingReport(
  req: IncomingMessage,
  res: ServerResponse,
  bookId: string,
  timeoutMs: number
): Promise<void> {
  const raw = await readJsonBody(req, timeoutMs)
  const parsed = raw.ok ? parseReadingReport(raw.body) : ({ ok: false } as const)
  if (!parsed.ok) {
    sendJson(res, 400, errorPayload('badRequest'))
    return
  }

  const outcome = await applyReadingReport(bookId, parsed.report)
  if (!outcome.ok) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }

  sendJson(
    res,
    200,
    readingPayload({
      applied: outcome.applied,
      book: outcome.book,
      shelves: shelfIdsFor(outcome.book.id)
    })
  )
}

// ---------------------------------------------------------------------------
// The third and fourth writes: the shelf membership toggle (bookshelves D10)
// ---------------------------------------------------------------------------

/**
 * `PUT|DELETE /api/shelves/{shelfId}/books/{bookId}` — the membership toggle
 * (bookshelves D10).
 *
 * **Idempotent by the service's own rules, not by a check here:** an add of an
 * existing member keeps its `added_at` and writes nothing (`Applied.changed`),
 * and a remove of a non-member is the same no-op — both answer 200, and both are
 * why a queued or replayed toggle is safe.
 *
 * **The answer is the book read back after the write** (S8), in the detail
 * shape: the write and the read that follows it are one round trip, exactly as
 * the reading report's answer is.
 *
 * The order is S10's: the share (503, `Retry-After: 5`) before the resources
 * (404) — the cover and file routes' own order, kept because the client's retry
 * decision does not depend on whether the shelf exists. The existence checks run
 * on the **cache**, before anything is attempted, because the service skips
 * unknown book ids silently (it must — the Mac's own callers rely on that) and
 * would otherwise answer 200 for a book that is not there (S3).
 */
async function handleShelfMembership(
  req: IncomingMessage,
  res: ServerResponse,
  path: ShelfBookPath,
  add: boolean
): Promise<void> {
  if (!nas.isOnline()) {
    sendUnavailable(res, 'offline')
    return
  }

  if (!shelfExists(path.shelfId) || !bookExists(path.bookId)) {
    sendJson(res, 404, errorPayload('notFound'))
    return
  }

  try {
    if (add) await addBooks(path.shelfId, [path.bookId])
    else await removeBooks(path.shelfId, [path.bookId])
  } catch (err) {
    if (isShelfGone(err)) {
      // Deleted between the check above and the mutation's own re-read of the
      // file (D3's *That shelf no longer exists*) — the same 404, from the
      // writer's own answer (S3)
      sendJson(res, 404, errorPayload('notFound'))
      return
    }
    if (!nas.isOnline()) {
      // **The share dropped between the check above and the service's own
      // `assertOnline`** — a window this route cannot close. Nothing was
      // written, and the contract's answer for a share that cannot take a write
      // is the pre-check's own: 503 `library offline` with `Retry-After`, not
      // this module's 500 (part 5b's review, finding 4; pinned by a case).
      sendUnavailable(res, 'offline')
      return
    }
    // An unreadable `shelves.json` lands here (S2): refused, never overwritten
    // (D3), with the service's own sentence in the log where a person can read
    // it — the wire gets the fixed word, as the upload's `internal` does
    console.warn(`[rest] ${req.method} ${req.url} — shelf write failed: ${describeError(err)}`)
    sendJson(res, 500, errorPayload('internal'))
    return
  }

  const book = getBook(path.bookId)
  if (!book) {
    // Unreachable by construction — the id was checked above and nothing in this
    // path deletes a book — so it is answered as this module's own failure
    // rather than asserted away (invariant 12), the upload handler's own shape
    console.warn('[rest] shelf write answered for a book the cache does not hold')
    sendJson(res, 500, errorPayload('internal'))
    return
  }

  sendJson(res, 200, membershipPayload({ book, shelves: shelfIdsFor(book.id) }))
}

// ---------------------------------------------------------------------------
// The second write: a book arriving as bytes (D1, D5, D6)
// ---------------------------------------------------------------------------

/**
 * The upload's refusal vocabulary, mapped once — a lookup, not a judgement.
 *
 * The reasons are `services/api/upload.ts`'s own union, and the `Record` is over
 * it, so a sixth reason there is a `npm run typecheck` failure here until its
 * status is named. That is the same discipline `services/api/routes.ts` keeps
 * for the cover resolver's two refusals, and it exists because a reason with no
 * status is a request nobody answers.
 *
 * `offline` is deliberately **not** in the table: it is the byte routes' own
 * 503, with `Retry-After: 5` and a word that is not a JSON body's business
 * (`sendUnavailable` writes it), so the writer below hands that one reason
 * across rather than duplicating the shape here.
 *
 * `stalled` is a **400**, and it is the reading route's own precedent: a body
 * that never finished arriving is a request this surface could not make sense
 * of, which is the client's error and not this machine's. Slice 1's first
 * revision of that rule answered `internal` for a silence the *handler* caused
 * (a paused request, a target that stopped draining) and that one stays
 * `internal` — the two are different sentences and the vocabulary keeps both.
 */
const UPLOAD_REFUSALS: Record<
  Exclude<UploadRefusal, 'offline'>,
  { status: number; error: ApiError }
> = {
  'bad-request': { status: 400, error: 'badRequest' },
  'too-large': { status: 413, error: 'tooLarge' },
  stalled: { status: 400, error: 'badRequest' },
  internal: { status: 500, error: 'internal' }
}

/**
 * Answer a refusal, and keep the message out of it.
 *
 * An `internal` refusal's `message` is the **filesystem's own** and carries this
 * machine's absolute paths (slice 1's review: a full `userData` volume, an
 * `ENAMETOOLONG`), so it goes to the log where a person can read it and never to
 * the wire, where the client gets the fixed word.
 */
function sendUploadRefusal(
  res: ServerResponse,
  outcome: { reason: UploadRefusal; message?: string }
): void {
  if (outcome.message)
    console.warn(`[rest] upload refused (${outcome.reason}) — ${outcome.message}`)

  if (outcome.reason === 'offline') {
    sendUnavailable(res, 'offline')
    return
  }
  const answer = UPLOAD_REFUSALS[outcome.reason]
  sendJson(res, answer.status, errorPayload(answer.error))
}

/**
 * `POST /api/books?format=<f>&filename=<n>` — a book arriving as bytes (D1).
 * The API's first write that *creates* a row rather than editing one.
 *
 * **Thin by construction (invariant 8).** Everything this route decides is the
 * table above and the seam below: the parameters, the share check, the body's
 * two bounds, the scratch-file lifecycle and the import itself are
 * `services/api/upload.ts`'s — built socketless in the previous slice for
 * exactly this call — and the import is `importer.addFiles`, the same entry
 * point the Mac's own picker and the `imports/` watcher use. What is left here
 * is HTTP's own business: a status line, a slot from the transfer gate, and a
 * payload.
 *
 * **The transfer gate wraps the body** (D5). An upload is the same shape as a
 * download — minutes, not a burst, in the four-slot libuv threadpool the app's
 * own cover loads share — so it takes one of the two slots, and a request that
 * arrives with both spent gets the byte routes' own `503 busy` +
 * `Retry-After: 1`. Two consequences, both stated rather than discovered:
 *
 * - **The slot is taken before the parameters are validated**, so a request that
 *   is both malformed *and* arriving at a busy server answers `busy` rather than
 *   `400`. The alternative — validating here — puts a second copy of
 *   `parseUploadQuery`'s decision in the socket module, which is precisely what
 *   invariant 8 forbids.
 * - **A silent client does not hold its slot forever, unlike a download**: the
 *   handler's own 30 s stall clock ends the wait and the `finally` below hands
 *   the slot back. A wedged *read* has no timer, which is why the byte routes
 *   cannot promise the same thing (docs/rest-api.md, *Concurrent byte transfers*).
 *
 * **201, with the row as the import returned it** (D6, S7). The book is read
 * back out of the cache rather than taken from the importer's in-memory value,
 * and it is pre-hydration by design: the Mac's own contract is that a book is in
 * the library the moment it is inserted, and blocking the answer on a network
 * fetch would hold a transfer slot for up to five seconds to make the client's
 * first look the settled one.
 */
async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps
): Promise<void> {
  if (!deps.gate.acquire()) {
    sendUnavailable(res, 'busy')
    return
  }

  try {
    const outcome = await receiveUpload(req, url.searchParams, deps.upload)
    if (!outcome.ok) {
      sendUploadRefusal(res, outcome)
      return
    }

    const book = outcome.result.bookId ? getBook(outcome.result.bookId) : null
    if (!book) {
      // The importer reported a success for a row the cache does not hold. It is
      // unreachable by construction (an insert precedes the result), so it is
      // answered as this module's own failure rather than asserted away with a
      // non-null assertion — invariant 12, and a 500 is a status the contract
      // already carries.
      console.warn('[rest] upload imported a book the cache does not hold')
      sendJson(res, 500, errorPayload('internal'))
      return
    }

    sendJson(
      res,
      201,
      importPayload({
        book,
        duplicate: outcome.result.duplicate ?? null,
        shelves: shelfIdsFor(book.id)
      })
    )
  } finally {
    deps.gate.release()
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * One request.
 *
 * **The auth check runs before the routing switch**, so an unauthenticated
 * request cannot reach a route's logic at all — not even far enough to learn
 * that the route exists.
 *
 * **The method policy is stated rather than implied** (and written out in
 * `docs/rest-api.md`): every read route is a `GET`, the four writes name their
 * own methods, and the five JSON routes also answer `HEAD`. `HEAD /api/health` answering 404 is what
 * a `URLSession` probe would meet where a connect check belongs, and
 * `node:http` makes the fix free — it suppresses the body of a `HEAD` response
 * while keeping the headers, so no route has to know the method. The two byte
 * routes stay `GET`-only, which is D15's own decision: `HEAD` probing buys
 * nothing when the length arrives with the first response. The **writes** are
 * the exceptions that have to name their methods — `PUT /api/books/{id}/reading`
 * and slice 5's membership pair, each matched on its resource *and* its method —
 * and a `GET` of one of those paths is a known path behind a method it does not
 * answer — 404 like any other (D11).
 *
 * `POST /api/books` — slice 2's upload — is the other exception, and its
 * policy is stated here for the same reason: it takes a **body of raw bytes**,
 * so a `HEAD` on it has nothing to answer with beyond a status (`GET
 * /api/books/{id}/file` is the same shape and the same answer), and it is
 * therefore deliberately **left out of the `HEAD` allowlist**. One rule and no
 * new status: `HEAD /api/books` is a known path behind a method it does not
 * answer, which is the uniform 404 above.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedRestApiConfig,
  deps: RouteDeps
): Promise<void> {
  try {
    const auth = checkBearer(req.headers.authorization, config.token)
    if (!auth.ok) {
      logRejectedAttempt(clientAddress(req))
      sendJson(res, 401, errorPayload('unauthorized'), { 'www-authenticate': 'Bearer' })
      return
    }

    // A request target with no origin-form path cannot be parsed into a URL;
    // the base is a placeholder that never resolves anything.
    const url = new URL(req.url ?? '/', 'http://musaeum.invalid')

    const json = req.method === 'GET' || req.method === 'HEAD'
    const body = req.method === 'GET'

    if (json && url.pathname === HEALTH_ROUTE) {
      // The three values this payload needs, read where they live: the app's
      // own version (as `services/menu.ts` reads it), the cache's count through
      // the *paginated* total rather than a second `COUNT(*)`, and whether the
      // share is mounted. Shaping them is `shape.ts`'s.
      sendJson(
        res,
        200,
        healthPayload({ version: app.getVersion(), books: countBooks(), online: nas.isOnline() })
      )
      return
    }

    if (json && url.pathname === LIBRARY_ROUTE) {
      const parsed = parseLibraryQuery(url)
      if (!parsed.ok) {
        sendJson(res, 400, errorPayload('badRequest'))
        return
      }
      const { filters, query, limit, offset } = parsed.query
      // An unknown shelf is a 404, answered from the cache before any query runs
      // (bookshelves D10): the same answer whether the share is mounted or not,
      // because this route never touches it.
      if (filters.shelfId && !shelfExists(filters.shelfId)) {
        sendJson(res, 404, errorPayload('notFound'))
        return
      }
      // A search is the app's own FTS path with the page appended; a list is
      // `getBooks`'s query with the page appended. Neither touches the share:
      // this route answers from the cache whatever the NAS is doing (D9/D11).
      const page = query
        ? searchBooksPage(query, { limit, offset }, filters)
        : getBooksPage(filters, { limit, offset })
      sendJson(
        res,
        200,
        libraryPayload({
          ...page,
          limit,
          offset,
          // One batched read over the page's ids — never one query per book
          shelves: shelfIdsForBooks(page.books.map((book) => book.id))
        })
      )
      return
    }

    if (json && url.pathname === FACETS_ROUTE) {
      const shelf = parseShelfParam(url.searchParams)
      if (!shelf.ok) {
        sendJson(res, 400, errorPayload('badRequest'))
        return
      }
      if (shelf.shelfId && !shelfExists(shelf.shelfId)) {
        sendJson(res, 404, errorPayload('notFound'))
        return
      }
      // Computed once over the whole library — or over one shelf, when `shelf`
      // is given (bookshelves D7/D10) — and deliberately not narrowed by the
      // list route's filters: a facet count that followed the current filter
      // would tell a client nothing about what it could filter *to*.
      sendJson(
        res,
        200,
        facetsPayload(getFacets(shelf.shelfId ? { shelfId: shelf.shelfId } : undefined))
      )
      return
    }

    if (json && url.pathname === SHELVES_ROUTE) {
      // The cache's own answer — 200 while the share is offline, like every
      // other JSON read (bookshelves D10). `count` counts only members the
      // library holds (D6), and `updatedAt` is the shelf file's own clock.
      sendJson(res, 200, shelvesPayload(listShelvesWithUpdatedAt()))
      return
    }

    // **The upload** (D1): the collection itself, matched on its method
    // and its pathname, with the book's bytes as the raw body. It sits with the
    // other early arms because the bare path never reaches `matchBookPath` — that
    // matcher's prefix carries a trailing slash — so a `GET`, a `HEAD` or a `PUT`
    // of this path falls through to the 404 below like any other known path
    // behind a method the route does not answer.
    if (req.method === 'POST' && isBooksCollection(url.pathname)) {
      await handleUpload(req, res, url, deps)
      return
    }

    // **The third and fourth writes** (bookshelves D10): the membership toggle,
    // and the API's first `DELETE`. The path matches; the method decides — and
    // anything but PUT or DELETE falls through to the uniform 404 below, because
    // a known path behind a method it does not answer is not distinguished from
    // no path at all (D11).
    const membership = matchShelfMembershipPath(url.pathname)
    if (membership && (req.method === 'PUT' || req.method === 'DELETE')) {
      await handleShelfMembership(req, res, membership, req.method === 'PUT')
      return
    }

    const book = matchBookPath(url.pathname)
    if (book) {
      // **The reading write** (D4), matched on its resource *and* its method: a
      // `GET` of this path is a known path behind a method it does not answer,
      // so it falls through to the 404 below like any other (D11).
      if (req.method === 'PUT' && book.resource === 'reading') {
        await handleReadingReport(req, res, book.id, deps.bodyTimeoutMs)
        return
      }

      if (json && book.resource === '') {
        const found = getBook(book.id)
        if (!found) {
          sendJson(res, 404, errorPayload('notFound'))
          return
        }
        sendJson(res, 200, bookPayload(found, shelfIdsFor(found.id)))
        return
      }

      if (body && book.resource === 'cover') {
        // **Stricter than the `musaeum://` handler on purpose** (AC14): the
        // handler resolves anything that is not `thumb` to the full cover
        // because the renderer only ever asks for its two fixed strings, while
        // this route is typed and validated before it calls the same resolver.
        const size = url.searchParams.get('size') ?? 'full'
        if (size !== 'thumb' && size !== 'full') {
          sendJson(res, 400, errorPayload('badRequest'))
          return
        }
        if (!nas.isOnline()) {
          sendUnavailable(res, 'offline')
          return
        }
        const cover = await resolveCoverFile(book.id, size)
        if (!cover.ok) {
          // The resolver's own split, carried through unchanged: 400 for a row
          // that escapes the library root, 404 for a missing root, book or
          // cover. The status→word table itself lives in `api/routes.ts` now —
          // one home for `API_ERRORS`, and a table the suite can decide
          // without a socket.
          sendJson(res, cover.status, errorPayload(refusalError(cover.status)))
          return
        }
        await sendBytes(req, res, { path: cover.path, contentType: 'image/jpeg' }, deps)
        return
      }

      if (body && book.resource === 'file') {
        const format = url.searchParams.get('format')
        if (!format) {
          sendJson(res, 400, errorPayload('badRequest'))
          return
        }
        if (!nas.isOnline()) {
          sendUnavailable(res, 'offline')
          return
        }
        if (format === 'reflow') {
          await serveReflow(req, res, book.id, deps)
          return
        }
        const path = await resolveBookFile(book.id, format)
        if (!path) {
          // Unknown format, a format the book does not hold, an unknown book, a
          // traversing `nasPath` and a missing file are one answer, uniformly
          // and reason-free (D11) — the same 404 `musaeum://book/…` makes
          sendJson(res, 404, errorPayload('notFound'))
          return
        }
        await sendBytes(req, res, { path, contentType: bookContentType(format) }, deps)
        return
      }
    }

    // An unmatched path, and a known path behind the wrong method, are the same
    // answer: 404 uniformly (D11). That includes a `GET` of the write route's
    // path, and any other method against a read route.
    sendJson(res, 404, errorPayload('notFound'))
  } catch (err) {
    // A handler must never throw out of a request (invariant 12): the failure
    // answers 500 and the process keeps serving. `sendJson` is total, so this
    // path cannot reject the promise the server handed to `void`.
    console.warn(`[rest] request failed: ${describeError(err)}`)
    sendJson(res, 500, errorPayload('internal'))
  }
}

/** What a case may change about the server it asks for. */
export interface ServerOptions {
  /**
   * How a byte transfer's body is written. Default `streamRange`, which streams
   * `fs.createReadStream` into the response. The seam exists so a case can hold
   * a transfer open and decide the byte cap without a slow disk (AC17), the same
   * reason `StartOptions.listen` exists below.
   */
  transfer?: ByteTransfer

  /**
   * How long a request body has to arrive; default `BODY_TIMEOUT_MS`. The seam
   * exists for the same reason `transfer` does — so a case can decide a lying
   * `Content-Length` in milliseconds rather than in ten seconds.
   */
  bodyTimeoutMs?: number

  /**
   * How the upload route's body is bounded and where its scratch file lands;
   * default `{}` — `services/api/upload.ts`'s own 1 GiB cap, 30 s stall clock
   * and `userData` scratch directory.
   *
   * The seam exists for the reason both above do, and it is the third of them
   * rather than a set of fields on this interface because the cap and the clock
   * are that module's decisions and not this one's: a case can decide an
   * oversized body and a stalled one in milliseconds (and keep the suite's
   * scratch directory its own) without a 1 GiB file or a thirty-second wait.
   */
  upload?: UploadOptions
}

/**
 * The server, wired but not listening: the routing switch, the auth check, the
 * JSON writer and the byte gate.
 *
 * Exported so a case can drive the real handler over a real socket on an
 * ephemeral port (`listen(0, '127.0.0.1')`, then read back the assigned port)
 * rather than unit-calling a function — the 401 path and the byte routes are
 * criteria only a socket can decide.
 */
export function createRestApiServer(
  config: ResolvedRestApiConfig,
  options: ServerOptions = {}
): Server {
  // One gate per server, and one server per process (activation runs once), so
  // this is the process-wide cap D9 names. It has to outlive a request for the
  // number to mean anything, which is why it is created here and not per request.
  const deps: RouteDeps = {
    transfer: options.transfer ?? streamRange,
    gate: createByteGate(),
    bodyTimeoutMs: options.bodyTimeoutMs ?? BODY_TIMEOUT_MS,
    // The upload's own bounds: the module's defaults unless a case replaced them
    upload: options.upload ?? {}
  }

  const server = createServer((req, res) => {
    // A socket-level failure on one request must not surface as an unhandled
    // 'error' on these objects, which would take the process down (invariant 12).
    req.on('error', () => undefined)
    res.on('error', () => undefined)
    void handleRequest(req, res, config, deps)
  })
  return server
}

/** What a listen attempt settled as. Never a throw — the caller records it. */
export type ListenOutcome =
  { ok: true; address: string; port: number } | { ok: false; message: string }

/**
 * How the server is put on the wire. The default is `node:http`'s own
 * `listen`; the seam exists so a case can decide the whole activation path
 * without a socket, which is also what lets it assert that *no* listen was
 * attempted rather than inferring it from a refused connection.
 */
export type ListenFn = (server: Server, host: string, port: number) => Promise<ListenOutcome>

/**
 * Listen, and report. The `'error'` listener stays attached for the server's
 * whole life — not only for the bind — because an unhandled `'error'` on a
 * listening server takes the process down, and this surface is never a fatal
 * path.
 */
async function listenOn(server: Server, host: string, port: number): Promise<ListenOutcome> {
  let settle: (outcome: ListenOutcome) => void = () => undefined
  const settled = new Promise<ListenOutcome>((resolve) => {
    settle = resolve
  })

  server.on('error', (err) => {
    const message = describeBindError(err, host, port)
    console.warn(`[rest] ${message}`)
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

/**
 * The listener activation opened, held so `stopRestApi()` can close it.
 *
 * One socket per process by construction: activation runs once, inside
 * `app.whenReady`, and this is assigned **only on a successful listen** — so a
 * second attempt the port refuses leaves the first socket reachable instead of
 * leaking it out of the reference. Null means nothing of ours is on the wire.
 */
let openServer: Server | null = null

/**
 * The three things activation reads from outside itself. Overridable so a case
 * can decide the whole path hermetically: **no case in the suite may bind this
 * machine's real tailnet address**, and none may read the dev profile's config.
 */
export interface StartOptions {
  /** Default: `resolveRestApiConfig()` — the three `rest_api_*` keys. */
  config?: ResolvedRestApiConfig
  /** Default: `os.networkInterfaces()`. */
  interfaces?: InterfaceMap
  /** Default: `listenOn` — a real `node:http` listener. */
  listen?: ListenFn
}

/**
 * Activate the API if the flag says so, and report what happened.
 *
 * Resolves with the recorded status and **never throws**: a refused address, a
 * taken port and a missing token are all recorded reasons rather than
 * exceptions, so the window opens whatever the network is doing (invariant 12 /
 * D11). Activation is called once per process — the call site is inside
 * `app.whenReady` — so this holds no guard against a second call: a second
 * attempt would be a second socket, which the port would refuse and the status
 * would report.
 */
export async function startRestApiIfEnabled(options: StartOptions = {}): Promise<RestApiStatus> {
  // The docblock's "never throws" made **structural** rather than asserted. The
  // call site is `void startRestApiIfEnabled()` inside `app.whenReady`, so a
  // rejection here would be an unhandled rejection at start-up — and one path
  // reaches this without any network involved at all: `resolveRestApiConfig()`
  // reads the database, which opens lazily and runs migrations, so a failing
  // open throws before the first `fail()` can record anything. Invariant 12.
  try {
    return await activate(options)
  } catch (err) {
    return fail(`activation failed — ${describeError(err)}`)
  }
}

async function activate(options: StartOptions): Promise<RestApiStatus> {
  const config = options.config ?? resolveRestApiConfig()
  // Captured before the `await` below: a stop arriving while the bind is in
  // flight moves `stopEpoch`, and the activation that was in flight loses.
  const epoch = stopEpoch

  if (!config.enabled) {
    // The flag's live value today. Nothing is created at all — no server, no
    // socket, no listen attempt (AC1).
    return record({ state: 'disabled', address: null, port: null, reason: null, at: null })
  }

  if (!config.token) {
    // Fail closed: a surface with no credential cannot compare anything, and
    // open access is the one thing it must never grow. Settings generates the
    // token on enable, so this is a hand-edited row.
    return fail(
      'rest_api_enabled is on but rest_api_token is empty — enable the API from Settings to generate one'
    )
  }

  const decision = resolveBindAddress(options.interfaces ?? networkInterfaces(), config.bind)
  if (!decision.ok || !decision.address) {
    // No bind is attempted at all, which is the whole content of the refusal
    return fail(decision.reason ?? 'no address to bind')
  }

  record({
    state: 'starting',
    address: decision.address,
    port: config.port,
    reason: null,
    at: new Date().toISOString()
  })

  const server = createRestApiServer(config)
  const outcome = await (options.listen ?? listenOn)(server, decision.address, config.port)

  if (!outcome.ok) return fail(outcome.message, decision.address, config.port)

  // **A stop that arrived while we were binding wins.** It asked for nothing on
  // the wire, and without this the socket would be opened *after* the stop had
  // already reported success — with nothing holding a reference to close it,
  // because the stop took the "nothing was started" branch while this was still
  // awaiting. Slice 2's toggle is where it fires: enable, change your mind,
  // disable.
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

/**
 * Bumped by every stop. An activation that was in flight when it moved has been
 * cancelled — see the race handled in `activate`.
 */
let stopEpoch = 0

/**
 * Close a listener, dropping the connections it is holding. Never throws: it
 * returns the error's words, or null when there is nothing left open.
 *
 * `close()` alone leaves an in-flight transfer (a book, minutes long) holding
 * its socket, and a stop the owner asked for should not leave a download
 * running. The `!listening` guard is not an optimisation: `close()` on a server
 * that never listened calls back with `ERR_SERVER_NOT_RUNNING`, which would turn
 * a *successful* activation's status into a failure — and the `listen` seam
 * answers without ever binding, so that shape is reachable from a case.
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
 *
 * **Slice 2's Settings toggle needs start and stop to be symmetric**, and this
 * module owns its own socket: without this, disabling the API would write the
 * config, leave the socket listening and report `state: 'disabled'` — a status
 * that lies, which is worse than no status at all. Criterion 27 decides it the
 * only way it can be: by the machine, where a disabled API's port refuses a
 * connection.
 *
 * Idempotent and never fatal (invariant 12): stopping what was never started, or
 * stopping twice, is a settled no-op rather than an exception — the caller is a
 * switch, and a switch flipped twice is not an error.
 */
export async function stopRestApi(): Promise<RestApiStatus> {
  // First, so an activation that is mid-bind (it read the epoch before its own
  // `await`) learns it lost and closes its own socket instead of leaving one
  // open behind a status that says `disabled`.
  stopEpoch += 1

  const server = openServer
  openServer = null

  const stopped = (): RestApiStatus =>
    record({
      state: 'disabled',
      address: null,
      port: null,
      reason: null,
      at: new Date().toISOString()
    })

  // Never started (the flag is off, or activation failed before it bound), a
  // seam that answered without a socket, or an earlier stop: nothing of ours is
  // on the wire, which is what the caller asked for.
  if (!server) return stopped()

  const bound = server.address()
  const where =
    bound && typeof bound !== 'string' ? { address: bound.address, port: bound.port } : null

  const failure = await closeListener(server)
  if (failure) {
    // The socket may still be live, so the reference goes back and the status
    // says `failed` rather than `disabled`: claiming a dead socket that is still
    // listening is the exact lie this function exists to prevent. It gets its
    // own wording rather than `fail()`'s — that prefix says "not listening",
    // which is the opposite of what this path has to report, and slice 2 renders
    // `reason` verbatim.
    //
    // **Belt-and-braces, and said so rather than dressed up as a live
    // concern:** the guard in `closeListener` excludes the one error Node
    // documents for `close()`, so nothing in this suite reaches this branch, and
    // nothing can while `openServer` is module-private. What would decide it is
    // a `close` seam beside the existing `listen` one; until then this is a
    // code-read, not a decided claim — which is what AC8a's failure half is
    // recorded as.
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
): RestApiStatus {
  console.warn(`[rest] not listening — ${reason}`)
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

/**
 * A bind failure, in the words the Settings row can show. Three are the ones
 * this surface can actually hit, and each has a sentence worth reading — the
 * port is taken, the address is not on this machine, or the system refused the
 * listener. Anything else is the error's own message, which is the honest
 * answer when the cause is not one of the three.
 */
function describeBindError(err: unknown, host: string, port: number): string {
  const code = errorCode(err)
  if (code === 'EADDRINUSE') return `port ${port} is already in use on ${host} (EADDRINUSE)`
  if (code === 'EADDRNOTAVAIL') return `${host} is not an address on this machine (EADDRNOTAVAIL)`
  if (code === 'EACCES') return `the system refused a listener on ${port} (EACCES)`
  return describeError(err)
}
