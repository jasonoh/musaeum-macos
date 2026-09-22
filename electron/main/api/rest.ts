import { app } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { checkBearer, logRejectedAttempt } from '../services/api/auth'
import { resolveBindAddress, type InterfaceMap } from '../services/api/bind'
import { getBooks } from '../services/db'
import * as nas from '../services/nas-manager'
import { resolveRestApiConfig, type ResolvedRestApiConfig } from '../services/settings'

/**
 * `api/rest.ts` — the JSON API's socket, and the report of what it did.
 *
 * **Thin by construction (invariant 8).** Every decision this surface needs is
 * made elsewhere, and made testable without a socket: which address may be bound
 * is `services/api/bind.ts` (a pure function over an interface map), which port
 * and whether the flag is on are `services/settings.ts` (with validation before
 * write), and whether a request is allowed is `services/api/auth.ts` (a
 * constant-time comparison). What is left here is wiring — one routing switch,
 * one auth check, one JSON writer — which is the OPDS spec's D7 shape reused
 * rather than re-derived (`2026-09-19-opds-catalog-design.md`). No new
 * dependency: `node:http` is Node, and the main process is Node.
 *
 * **The status record below is a reporter, not business logic.** It is the one
 * thing only this module can know — what its own socket did — and it decides
 * nothing: the address, the port, the token and whether to start at all are all
 * settled in `services/`. Slice 2's Settings row reads it through a thin IPC
 * handler (`getRestApiStatus`), which is why it lives here rather than in
 * `services/`: nothing else would be reporting its own side effect.
 *
 * **Never fatal (invariant 12, D11).** A bind failure is logged, recorded and
 * the app starts normally; a thrown handler answers 500; an `'error'` on a
 * listening server is reported rather than thrown. No path in this module throws
 * out of `app.whenReady` or out of a request.
 */

/** The contract version the client checks (D12). Bump it on a payload change. */
export const API_VERSION = 1

/** The client's connect check. Slice 1b adds the library, book and byte routes. */
const HEALTH_ROUTE = '/api/health'

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

/** `GET /api/health` — the whole payload, so a case can pin its shape. */
export interface HealthPayload {
  apiVersion: number
  version: string
  books: number
  library: 'online' | 'offline'
}

/**
 * The connect check (D12): the contract's version, the app's own version, the
 * cache's book count and whether the share is mounted.
 *
 * The version is read the one way the repo reads it — `app.getVersion()`, as
 * `services/menu.ts` does — rather than from a second source that could
 * disagree. The count comes from `getBooks()`'s existing query on purpose: a
 * second SQL count would be a second place for the filter rules to drift, which
 * is invariant 4's reasoning.
 *
 * **That count is not free, and this says so rather than leaving it to be
 * discovered:** it loads and maps the whole cache — ~115ms at this library's
 * 7,100 books — synchronously on the main process, on the route the phone uses
 * as its connect check. Slice 1b's paginated total is what this becomes; the
 * replacement must not be a second `COUNT(*)` with its own filter rules, which
 * is the same drift the sentence above avoids.
 */
function healthPayload(): HealthPayload {
  return {
    apiVersion: API_VERSION,
    version: app.getVersion(),
    books: getBooks().length,
    library: nas.isOnline() ? 'online' : 'offline'
  }
}

/**
 * The one way a response is written: JSON, uncached, and **never a throw**.
 *
 * `cache-control: no-store` because health answers "where is the server now",
 * and a cached one is a wrong one — the lesson the cover URLs already learned.
 * The guard is the client that hung up mid-answer: there is nobody left to
 * answer, and a throw here would leave a rejected promise where invariant 12
 * wants a log line.
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

/**
 * One request.
 *
 * **The auth check runs before the routing switch**, so an unauthenticated
 * request cannot reach a route's logic at all — not even far enough to learn
 * that the route exists.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ResolvedRestApiConfig
): Promise<void> {
  try {
    const auth = checkBearer(req.headers.authorization, config.token)
    if (!auth.ok) {
      logRejectedAttempt(clientAddress(req))
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
      return
    }

    // A request target with no origin-form path cannot be parsed into a URL;
    // the base is a placeholder that never resolves anything.
    const url = new URL(req.url ?? '/', 'http://musaeum.invalid')

    if (req.method === 'GET' && url.pathname === HEALTH_ROUTE) {
      sendJson(res, 200, healthPayload())
      return
    }

    // Slice 1b's routes slot in here — library, facets, book, cover, file,
    // reading. This switch *is* the router (D2), and an unmatched path answers
    // 404 uniformly and reason-free (D11); a known path behind the wrong method
    // is not distinguished from no path at all.
    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    // A handler must never throw out of a request (invariant 12): the failure
    // answers 500 and the process keeps serving. `sendJson` is total, so this
    // path cannot reject the promise the server handed to `void`.
    console.warn(`[rest] request failed: ${describeError(err)}`)
    sendJson(res, 500, { error: 'internal' })
  }
}

/**
 * The server, wired but not listening: the routing switch, the auth check and
 * the JSON writer.
 *
 * Exported so a case can drive the real handler over a real socket on an
 * ephemeral port (`listen(0, '127.0.0.1')`, then read back the assigned port)
 * rather than unit-calling a function — the 401 path is the criterion, and only
 * a socket can decide it.
 */
export function createRestApiServer(config: ResolvedRestApiConfig): Server {
  const server = createServer((req, res) => {
    // A socket-level failure on one request must not surface as an unhandled
    // 'error' on these objects, which would take the process down (invariant 12).
    req.on('error', () => undefined)
    res.on('error', () => undefined)
    void handleRequest(req, res, config)
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
