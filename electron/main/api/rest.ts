import { app } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { pipeline } from 'node:stream/promises'
import type { BookFilters, BookFormat, BookSort, ReadStatus } from '@shared/book.types'
import { BOOK_FILE_EXTENSIONS, defaultSortDirection, isBookSort } from '@shared/book.types'
import { checkBearer, logRejectedAttempt } from '../services/api/auth'
import { resolveBindAddress, type InterfaceMap } from '../services/api/bind'
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  READ_STATUSES,
  bookPayload,
  errorPayload,
  facetsPayload,
  healthPayload,
  libraryPayload
} from '../services/api/shape'
import {
  parseByteRange,
  resolveBookFile,
  resolveCoverFile,
  bookContentType
} from '../services/book-bytes'
import { countBooks, getBook, getBooksPage, getFacets, searchBooksPage } from '../services/db'
import * as nas from '../services/nas-manager'
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
 * may be), the queries are `services/db.ts` (one WHERE body, one `ORDER BY`,
 * paging appended), the path and range rules are `services/book-bytes.ts`, and
 * the bytes come from the NAS. What is left here is wiring — one routing switch,
 * one auth check, one JSON writer, one byte writer — which is the OPDS spec's D7
 * shape reused rather than re-derived (`2026-09-19-opds-catalog-design.md`). No
 * new dependency: `node:http` is Node, and the main process is Node.
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
 * `GET /api/books/{id}`, `GET /api/books/{id}/cover`, and
 * `GET /api/books/{id}/file`. The write route (`PUT /api/books/{id}/reading`) is
 * slice 1c's, and lands in the same switch.
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
 * The library routes are matched by these three constants and the `/api/books/`
 * prefix below: an unmatched path answers 404 uniformly and reason-free (D11),
 * and a known path behind the wrong method is not distinguished from no path at
 * all.
 */
const HEALTH_ROUTE = '/api/health'
const LIBRARY_ROUTE = '/api/library'
const FACETS_ROUTE = '/api/library/facets'
const BOOKS_PREFIX = '/api/books/'

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
}

/** A file to serve, and the type its bytes are labelled with. */
interface ByteSource {
  path: string
  contentType: string
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
    try {
      size = (await fs.stat(source.path)).size
    } catch {
      sendJson(res, 404, errorPayload('notFound'))
      return
    }

    const shared = {
      'content-type': source.contentType,
      'cache-control': 'no-store',
      'accept-ranges': 'bytes'
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
// The library routes' parameters
// ---------------------------------------------------------------------------

/** What `GET /api/library` was asked for. */
interface LibraryQuery {
  /** The filters, including `sort` — the same object shape the app's own list takes. */
  filters: BookFilters
  /** The search term, or null for a plain list. */
  query: string | null
  limit: number
  offset: number
}

/** A request this surface cannot make sense of: answered 400, never defaulted. */
const INVALID_QUERY: { ok: false } = { ok: false }

/**
 * The library route's parameters, as the wire's shape.
 *
 * **Every rule this applies is imported, not re-declared here:** which sort
 * fields and directions exist is `isBookSort` and `defaultSortDirection`
 * (`@shared/book.types`), which formats exist is `BOOK_FILE_EXTENSIONS`, which
 * read statuses exist is `READ_STATUSES` (the shaper's own values, so the
 * filter can only accept what the payload can report), and the page's bounds are
 * the shaper's `DEFAULT_PAGE_LIMIT`/`MAX_PAGE_LIMIT` — the same numbers the
 * response echoes back.
 *
 * What *is* decided here is what a malformed parameter means, and the answer is
 * a 400 rather than a silent default: a client that asked for `sort=athor` and
 * received title order would have no way to learn it had a typo. A `limit` above
 * the cap is the one value that is clamped rather than refused — asking for
 * everything is a request this surface can satisfy, at 500 rows.
 */
function parseLibraryQuery(url: URL): { ok: true; query: LibraryQuery } | { ok: false } {
  const params = url.searchParams

  const limit = intParam(params.get('limit'), DEFAULT_PAGE_LIMIT)
  if (limit === null) return INVALID_QUERY
  const offset = intParam(params.get('offset'), 0)
  if (offset === null) return INVALID_QUERY

  const filters: BookFilters = {}

  const authors = listParam(params, 'authors')
  if (authors) filters.authors = authors
  const series = listParam(params, 'series')
  if (series) filters.series = series
  const tags = listParam(params, 'tags')
  if (tags) filters.tags = tags

  const formats = listParam(params, 'formats')
  if (formats) {
    if (!formats.every((f) => f in BOOK_FILE_EXTENSIONS)) return INVALID_QUERY
    filters.formats = formats as BookFormat[]
  }

  const readStatus = listParam(params, 'readStatus')
  if (readStatus) {
    if (!readStatus.every((s) => s in READ_STATUSES)) return INVALID_QUERY
    filters.readStatus = readStatus as ReadStatus[]
  }

  const minRating = intParam(params.get('minRating'), null)
  if (minRating === null && params.get('minRating') !== null) return INVALID_QUERY
  if (minRating !== null) filters.minRating = minRating

  const sort = parseSort(params)
  if (!sort.ok) return INVALID_QUERY
  if (sort.sort) filters.sort = sort.sort

  const query = params.get('q')?.trim() ?? ''
  return {
    ok: true,
    query: {
      filters,
      query: query || null,
      limit: Math.min(limit, MAX_PAGE_LIMIT),
      offset
    }
  }
}

/**
 * A whole, non-negative number, or `null` when the parameter is present and is
 * not one. `fallback` may itself be `null`, which is how an optional parameter
 * (one that is only 400 when it is *there* and wrong) is read.
 */
function intParam(raw: string | null, fallback: number | null): number | null {
  if (raw === null || raw === '') return fallback
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * A filter list: a repeated parameter and a comma-separated one are the same
 * thing, because a query string is written by hand in a smoke script and by a
 * URL builder in the client, and neither form should be the wrong one.
 */
function listParam(params: URLSearchParams, name: string): string[] | null {
  const values = params
    .getAll(name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  return values.length ? values : null
}

/**
 * `sort` / `dir`, through the guard that exists for a sort from outside the type
 * system.
 *
 * Three answers, and each means something different. `{ sort: null }` is "no sort
 * asked for" — which is *not* the same as `{ sort: { field: 'title', … } }`,
 * because a search without one keeps SQLite's FTS `rank`, an ordering no field
 * name can express. `{ ok: false }` is a 400. Anything else is the sort to run.
 *
 * `sort` alone defaults to `title`; `dir` alone is therefore a sort of titles,
 * and a direction that is neither `asc` nor `desc` is refused rather than
 * ignored. An absent `dir` takes the field's natural direction —
 * `defaultSortDirection`, the same rule the app's own sort control uses on a
 * first click — so a client asking for `sort=date_added` gets newest-first
 * rather than 1900-first.
 */
function parseSort(params: URLSearchParams): { ok: true; sort: BookSort | null } | { ok: false } {
  const field = params.get('sort')
  const direction = params.get('dir')
  if (field === null && direction === null) return { ok: true, sort: null }

  const candidate = { field: field ?? 'title', direction: direction ?? 'asc' }
  if (!isBookSort(candidate)) return { ok: false }

  return {
    ok: true,
    sort:
      direction === null
        ? { field: candidate.field, direction: defaultSortDirection(candidate.field) }
        : { field: candidate.field, direction: candidate.direction }
  }
}

/**
 * `/api/books/{id}`, `/api/books/{id}/cover`, `/api/books/{id}/file`.
 *
 * A book id is opaque and never touches the filesystem — it is a cache key, and
 * a traversing one is simply not a book (404). **Only `/api/books/`-prefixed
 * paths reach here**, and a path with extra segments is not one of the three
 * shapes, so it is not this route's business (`null`, and the switch's 404).
 */
function matchBookPath(pathname: string): { id: string; resource: '' | 'cover' | 'file' } | null {
  if (!pathname.startsWith(BOOKS_PREFIX)) return null

  const [segment, resource = '', ...rest] = pathname.slice(BOOKS_PREFIX.length).split('/')
  if (!segment || rest.length) return null
  if (resource !== '' && resource !== 'cover' && resource !== 'file') return null

  const id = decodeSegment(segment)
  return id ? { id, resource } : null
}

/** A percent-escaped path segment, or null when the escape is malformed. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
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
 * `docs/rest-api.md`): every route is a `GET`, and the four JSON routes also
 * answer `HEAD`. `HEAD /api/health` answering 404 is what a `URLSession` probe
 * would meet where a connect check belongs, and `node:http` makes the fix free —
 * it suppresses the body of a `HEAD` response while keeping the headers, so no
 * route has to know the method. The two byte routes stay `GET`-only, which is
 * D15's own decision: `HEAD` probing buys nothing when the length arrives with
 * the first response.
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
      // A search is the app's own FTS path with the page appended; a list is
      // `getBooks`'s query with the page appended. Neither touches the share:
      // this route answers from the cache whatever the NAS is doing (D9/D11).
      const page = query
        ? searchBooksPage(query, { limit, offset }, filters)
        : getBooksPage(filters, { limit, offset })
      sendJson(res, 200, libraryPayload({ books: page.books, total: page.total, limit, offset }))
      return
    }

    if (json && url.pathname === FACETS_ROUTE) {
      // Computed once over the whole library, deliberately not narrowed by the
      // list route's filters: a facet count that followed the current filter
      // would tell a client nothing about what it could filter *to*.
      sendJson(res, 200, facetsPayload(getFacets()))
      return
    }

    const book = matchBookPath(url.pathname)
    if (book) {
      if (json && book.resource === '') {
        const found = getBook(book.id)
        if (!found) {
          sendJson(res, 404, errorPayload('notFound'))
          return
        }
        sendJson(res, 200, bookPayload(found))
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
          // that escapes the library root, 404 for a missing root, book or cover
          sendJson(
            res,
            cover.status,
            errorPayload(cover.status === 400 ? 'badRequest' : 'notFound')
          )
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
    // answer: 404 uniformly (D11). `PUT /api/books/{id}/reading` is slice 1c's,
    // and this switch is where it lands.
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
  const deps: RouteDeps = { transfer: options.transfer ?? streamRange, gate: createByteGate() }

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
