import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BookSort } from '@shared/book.types'
import type { ManualShelfEntry } from '@shared/shelf.types'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { type InterfaceMap } from '../services/api/bind'
import * as db from '../services/db'
import { subscribe } from '../services/events'
import * as nas from '../services/nas-manager'
import * as reflow from '../services/reflow'
import { resolveBookFile } from '../services/book-bytes'
import type { ReflowResult } from '@shared/book.types'
import * as shelves from '../services/shelves'
import { readShelvesFile } from '../services/shelves-file'
import {
  DEFAULT_REST_API_PORT,
  REST_API_CONFIG_KEYS,
  getSettings,
  resolveRestApiConfig,
  saveSettings,
  type ResolvedRestApiConfig
} from '../services/settings'
import {
  REFLOW_GRACE_MS,
  createRestApiServer,
  getRestApiStatus,
  startRestApiIfEnabled,
  stopRestApi,
  type ListenOutcome
} from './rest'

/**
 * The pipe (slice 1a of the iOS companion) — the whole integration file.
 *
 * Three layers, in the order the app meets them: the config keys the server is
 * configured by, the activation that decides whether anything listens, and the
 * wire itself, driven over a **real socket on an ephemeral port** rather than by
 * unit-calling the handler: the 401 path is the criterion, and only a socket can
 * decide it.
 *
 * Hermetic by construction: the `electron` alias gives every worker a throwaway
 * `userData` (so the database here is a scratch one), the version is supplied by
 * the mock, the interfaces are fixtures, and **every socket this file opens is
 * closed by the case that opened it**. The one path the suite must never take is
 * a real listen on this machine's tailnet address, which is why the address
 * resolution is fed fixture maps.
 *
 * The success path of activation is driven with an injected `listen`
 * (`StartOptions`), so it asserts the status without opening a socket it would
 * have no reference to close.
 */

const { APP_VERSION } = vi.hoisted(() => ({ APP_VERSION: '9.9.9-test' }))

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('electron')>()
  // The real app answers `app.getVersion()` from package.json; the mock has no
  // such method, and a fixed one makes the health payload's version assertable
  return { ...actual, app: { ...actual.app, getVersion: () => APP_VERSION } }
})

vi.mock('../services/nas-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/nas-manager')>()
  // The only way to reach `library: 'online'` without a mounted share.
  //
  // `assertOnline` is **wrapped, not stubbed** (the `../services/db` mock's own
  // idiom below): the real gate still answers every ordinary case, and one case
  // can stage the window between this route's `isOnline` pre-check and the
  // service's own gate — the share that drops in between — which is otherwise
  // unreachable without a real share to unmount (part 5b's review, finding 4).
  return { ...actual, isOnline: vi.fn(() => false), assertOnline: vi.fn(actual.assertOnline) }
})

vi.mock('../services/reflow')

vi.mock('../services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/db')>()
  // A wrapper, not a stub: the real query still answers, and one case can make
  // it throw to prove a failed handler answers 500 instead of dying. All three
  // are wrapped because 1b moved the health route's count onto `countBooks` (the
  // paginated total) and the library route onto `getBooksPage`, so "the 401 path
  // ran no query" is a claim about the callables the routes actually reach.
  return {
    ...actual,
    getBooks: vi.fn(actual.getBooks),
    getBooksPage: vi.fn(actual.getBooksPage),
    countBooks: vi.fn(actual.countBooks)
  }
})

const TOKEN = 'a1b2c3d4'.repeat(8)
const WRONG = 'deadbeef'.repeat(8)

/** The machine as measured 2026-09-22, as a fixture — never this machine's map. */
const MEASURED: InterfaceMap = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
  utun9: [{ address: '100.64.0.1', family: 'IPv4', internal: false }],
  utun8: [{ address: '10.0.0.2', family: 'IPv4', internal: false }]
}

function config(overrides: Partial<ResolvedRestApiConfig> = {}): ResolvedRestApiConfig {
  return { enabled: true, port: DEFAULT_REST_API_PORT, bind: '', token: TOKEN, ...overrides }
}

/** A listen that answers without a socket, so "was it attempted?" is decidable. */
function recordingListen(
  outcome: ListenOutcome = { ok: true, address: '100.64.0.1', port: DEFAULT_REST_API_PORT }
) {
  return vi.fn(async (_server: Server, _host: string, _port: number) => outcome)
}

/** A port nothing is listening on: bound, read back, released. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

beforeEach(() => {
  vi.mocked(nas.isOnline).mockReturnValue(false)
  vi.mocked(db.getBooks).mockClear()
  vi.mocked(db.getBooksPage).mockClear()
  vi.mocked(db.countBooks).mockClear()
  closeAndWipe()
})

/** The dev database is never touched: the electron mock points userData at a temp dir. */
function closeAndWipe(): void {
  db.closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
}

// ---------------------------------------------------------------------------
// The keys the server is configured by (AC6, D13)
// ---------------------------------------------------------------------------

describe('the keys the server is configured by', () => {
  it('starts disabled, on the default port, with no token and no bind', () => {
    expect(resolveRestApiConfig()).toEqual({
      enabled: false,
      port: DEFAULT_REST_API_PORT,
      bind: '',
      token: null
    })
  })

  it('generates a token the first time the API is enabled (AC6)', () => {
    saveSettings({ restApiEnabled: 'true' })

    const resolved = resolveRestApiConfig()
    expect(resolved.enabled).toBe(true)
    expect(resolved.token).toMatch(/^[0-9a-f]{64}$/)
    expect(db.getConfig(REST_API_CONFIG_KEYS.token)).toBe(resolved.token)
  })

  it('keeps the token a second enable, and across a disable (AC6)', () => {
    saveSettings({ restApiEnabled: 'true' })
    const first = db.getConfig(REST_API_CONFIG_KEYS.token)

    // The phone was configured once. Nothing in this app may replace the
    // credential out from under it.
    saveSettings({ restApiEnabled: 'true' })
    expect(db.getConfig(REST_API_CONFIG_KEYS.token)).toBe(first)

    saveSettings({ restApiEnabled: 'false' })
    saveSettings({ restApiEnabled: 'true' })
    expect(db.getConfig(REST_API_CONFIG_KEYS.token)).toBe(first)
  })

  it('generates no token for a save that does not enable it', () => {
    saveSettings({ restApiPort: '9000' })
    expect(db.getConfig(REST_API_CONFIG_KEYS.token)).toBeNull()
  })

  it('hands the server the real token, not the masked view the UI gets', () => {
    saveSettings({ restApiEnabled: 'true' })
    const token = resolveRestApiConfig().token

    // `resolved` masks secrets by design, which is why the server must not be
    // routed through `getSettings()` — that is what this resolver is for
    expect(getSettings().resolved).not.toHaveProperty('restApiToken')
    expect(db.getConfig(REST_API_CONFIG_KEYS.token)).toBe(token)
  })

  it('writes and clears the port and the bind, deleting the key on a blank', () => {
    saveSettings({ restApiPort: '9000', restApiBind: '100.64.0.1' })
    expect(db.getConfig(REST_API_CONFIG_KEYS.port)).toBe('9000')
    expect(db.getConfig(REST_API_CONFIG_KEYS.bind)).toBe('100.64.0.1')

    saveSettings({ restApiPort: '', restApiBind: '' })
    // Deleted, not blanked — every reader treats missing as "use the default"
    expect(db.getConfig(REST_API_CONFIG_KEYS.port)).toBeNull()
    expect(db.getConfig(REST_API_CONFIG_KEYS.bind)).toBeNull()
    expect(resolveRestApiConfig()).toMatchObject({ port: DEFAULT_REST_API_PORT, bind: '' })
  })

  it.each([
    ['restApiEnabled', 'yes', /Not a flag/],
    ['restApiEnabled', 'TRUE', /Not a flag/],
    ['restApiPort', '80', /Not a port/],
    ['restApiPort', '65536', /Not a port/],
    ['restApiPort', 'eighty', /Not a port/],
    ['restApiPort', '8788.5', /Not a port/],
    ['restApiBind', '0.0.0.0', /Not a bind address/],
    ['restApiBind', '192.168.1.10', /Not a bind address/],
    ['restApiBind', '10.0.0.2', /Not a bind address/],
    ['restApiBind', 'example.com', /Not a bind address/],
    ['restApiToken', 'short', /Not a token/]
  ])('rejects %s = %s', (field, value, message) => {
    expect(() => saveSettings({ [field]: value })).toThrow(message)
  })

  it('accepts a loopback bind, which is how loopback is asked for', () => {
    saveSettings({ restApiBind: '127.0.0.1' })
    expect(db.getConfig(REST_API_CONFIG_KEYS.bind)).toBe('127.0.0.1')
  })

  it('does not echo a rejected token back in the error', () => {
    const secret = 'not a token, but still a secret'
    expect(() => saveSettings({ restApiToken: secret })).toThrow(/Not a token/)
    try {
      saveSettings({ restApiToken: secret })
    } catch (err) {
      expect((err as Error).message).not.toContain(secret)
    }
  })

  it('writes nothing when any field in the batch fails validation', () => {
    saveSettings({ restApiPort: '9000' })

    // The migration seeds `rest_api_enabled = 'false'`, so "unchanged" is
    // 'false': what this asserts is that the rejected save did not flip it.
    //
    // **The enabling entry is first on purpose.** A batch whose throwing field
    // came first would prove only that a rejected save writes nothing — it
    // would also pass an implementation that generated the token *during*
    // validation, which is the plausible regression. Reaching the enabling
    // entry and then throwing is what makes this case discriminate.
    expect(() => saveSettings({ restApiEnabled: 'true', restApiPort: '80' })).toThrow()

    // The previous value is intact, nothing was written, and the rejected save
    // generated no credential — validation runs before any write
    expect(db.getConfig(REST_API_CONFIG_KEYS.port)).toBe('9000')
    expect(db.getConfig(REST_API_CONFIG_KEYS.enabled)).toBe('false')
    expect(db.getConfig(REST_API_CONFIG_KEYS.token)).toBeNull()
  })

  it('falls back to the default port when a hand-edited row holds nonsense', () => {
    // Storage is not trusted on the read path: a port `listen()` would throw on
    // must not reach `listen()`
    db.setConfig(REST_API_CONFIG_KEYS.port, 'not-a-port')
    expect(resolveRestApiConfig().port).toBe(DEFAULT_REST_API_PORT)
    db.setConfig(REST_API_CONFIG_KEYS.port, '80')
    expect(resolveRestApiConfig().port).toBe(DEFAULT_REST_API_PORT)
  })
})

// ---------------------------------------------------------------------------
// Activation: what listens, and what is recorded when nothing can (AC1, AC4, AC5)
// ---------------------------------------------------------------------------

describe('activation', () => {
  it('creates no socket at all when the flag is absent (AC1)', async () => {
    const port = await freePort()
    const listen = recordingListen()

    const status = await startRestApiIfEnabled({
      config: config({ enabled: false, port }),
      interfaces: MEASURED,
      listen
    })

    expect(status.state).toBe('disabled')
    expect(listen).not.toHaveBeenCalled()

    // The same assertion made by the machine: the configured port refuses the
    // connection, because nothing was ever created to hold it
    await expect(
      fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    ).rejects.toThrow()
  })

  it('creates no socket when the flag is stored as false (AC1)', async () => {
    db.setConfig(REST_API_CONFIG_KEYS.enabled, 'false')
    const listen = recordingListen()

    const status = await startRestApiIfEnabled({ interfaces: MEASURED, listen })

    expect(resolveRestApiConfig().enabled).toBe(false)
    expect(status).toEqual(getRestApiStatus())
    // And the getter hands back a copy: nothing a caller does to the report
    // reaches the record this module keeps
    expect(getRestApiStatus()).not.toBe(status)
    expect(status.state).toBe('disabled')
    expect(listen).not.toHaveBeenCalled()
  })

  it('reports the resolved tailnet address and port when it does listen', async () => {
    const listen = recordingListen()

    const status = await startRestApiIfEnabled({ config: config(), interfaces: MEASURED, listen })

    expect(status).toEqual({
      state: 'listening',
      address: '100.64.0.1',
      port: DEFAULT_REST_API_PORT,
      reason: null,
      at: expect.any(String)
    })
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen.mock.calls[0].slice(1)).toEqual(['100.64.0.1', DEFAULT_REST_API_PORT])
  })

  it('names the port the OS actually assigned', async () => {
    const listen = recordingListen({ ok: true, address: '127.0.0.1', port: 54321 })
    const status = await startRestApiIfEnabled({
      config: config({ port: 0, bind: '127.0.0.1' }),
      interfaces: MEASURED,
      listen
    })
    expect(status.port).toBe(54321)
  })

  it('refuses an override that is neither loopback nor a tailnet address, and does not bind (AC4)', async () => {
    const listen = recordingListen()

    const status = await startRestApiIfEnabled({
      config: config({ bind: '192.168.1.10' }),
      interfaces: MEASURED,
      listen
    })

    expect(status.state).toBe('failed')
    expect(status.reason).toMatch(/neither loopback nor a tailnet address/)
    expect(listen).not.toHaveBeenCalled()
  })

  it('refuses with a reason when the fixture map holds no tailnet address (AC4)', async () => {
    const listen = recordingListen()

    const status = await startRestApiIfEnabled({
      config: config(),
      interfaces: { utun8: [{ address: '10.0.0.2', family: 'IPv4', internal: false }] },
      listen
    })

    expect(status.state).toBe('failed')
    expect(status.reason).toContain('100.64.0.0/10')
    expect(listen).not.toHaveBeenCalled()
  })

  it('refuses to serve without a token, rather than serving everyone (D11)', async () => {
    const listen = recordingListen()

    const status = await startRestApiIfEnabled({
      config: config({ token: null }),
      interfaces: MEASURED,
      listen
    })

    expect(status.state).toBe('failed')
    expect(status.reason).toMatch(/rest_api_token is empty/)
    expect(listen).not.toHaveBeenCalled()
  })

  it('records a taken port as a reason and does not throw (AC5)', async () => {
    // A real socket holds the port, and the real `node:http` listener meets it
    const held = createServer()
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve))
    const port = (held.address() as AddressInfo).port

    try {
      const status = await startRestApiIfEnabled({
        config: config({ port, bind: '127.0.0.1' }),
        interfaces: MEASURED
      })

      expect(status.state).toBe('failed')
      expect(status.reason).toMatch(/already in use/)
      expect(status.reason).toContain('EADDRINUSE')
      // The port it tried, kept so a Settings row can say which one
      expect(status).toMatchObject({ address: '127.0.0.1', port })
      // The credential never reaches the report
      expect(JSON.stringify(status)).not.toContain(TOKEN)
      // And the reporter a Settings row reads agrees with the return value
      expect(getRestApiStatus()).toEqual(status)
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// The wire: the real handler, over a real socket (AC2)
// ---------------------------------------------------------------------------

describe('the wire', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    db.insertBook(makeBook('one', 'One'))
    db.insertBook(makeBook('two', 'Two'))

    // Port 0 in the config means nothing to the handler — the case picks its own
    // ephemeral port below and reads the assigned one back
    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('answers 401 with WWW-Authenticate: Bearer when there is no header (AC2)', async () => {
    const res = await fetch(`${base}/api/health`)

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    // The 401 path reaches no route: the health route's queries never ran, so an
    // unauthenticated request cannot even learn that the route exists
    expect(vi.mocked(db.countBooks)).not.toHaveBeenCalled()
    expect(vi.mocked(db.getBooksPage)).not.toHaveBeenCalled()
  })

  it('answers 401 for a wrong token and for a malformed one (AC2)', async () => {
    const wrong = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${WRONG}` }
    })
    const malformed = await fetch(`${base}/api/health`, { headers: { authorization: 'Basic x' } })

    expect(wrong.status).toBe(401)
    expect(malformed.status).toBe(401)
    expect(vi.mocked(db.countBooks)).not.toHaveBeenCalled()
    expect(vi.mocked(db.getBooksPage)).not.toHaveBeenCalled()
  })

  it('logs the client address and never the attempted credential (AC3)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${WRONG}` } })
      const logged = warn.mock.calls.flat().join(' ')

      expect(logged).toContain('127.0.0.1')
      expect(logged).not.toContain(WRONG)
      expect(logged).not.toContain(TOKEN)
    } finally {
      warn.mockRestore()
    }
  })

  it('answers 200 with the health payload for the right token (AC2)', async () => {
    const res = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      apiVersion: 1,
      version: APP_VERSION,
      books: 2,
      library: 'offline'
    })

    // **1b's count, and the reason it is a count.** The route asks `countBooks`
    // for the paginated total and never pages the library through `getBooksPage`,
    // which is what retires the whole-library load 1a answered this route with
    // (~115 ms at 7,100 books, synchronously, on the phone's connect check).
    expect(vi.mocked(db.countBooks)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.getBooksPage)).not.toHaveBeenCalled()
  })

  it('reports the library online exactly when the share is mounted', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(true)
    const res = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(await res.json()).toMatchObject({ library: 'online' })
  })

  it('answers 404 for an unmatched path, and 401 for one with no token', async () => {
    const unknown = await fetch(`${base}/api/nothing-here`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not found' })

    // Auth runs first, so an unknown path is not distinguished from a known one
    expect((await fetch(`${base}/api/nothing-here`)).status).toBe(401)
  })

  it('answers 500 when a route throws, and keeps serving (invariant 12)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.mocked(db.countBooks).mockImplementationOnce(() => {
        throw new Error('the cache is a brick')
      })

      const failed = await fetch(`${base}/api/health`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      expect(failed.status).toBe(500)
      expect(await failed.json()).toEqual({ error: 'internal' })

      // Same server, next request: the process is still serving
      const after = await fetch(`${base}/api/health`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      expect(after.status).toBe(200)
    } finally {
      warn.mockRestore()
    }
  })

  it('answers 500 when the library route throws, rather than dropping the request', async () => {
    // The other half of the same claim, on the read surface: a failing *query*
    // is a status, not a dead socket (invariant 12)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.mocked(db.getBooksPage).mockImplementationOnce(() => {
        throw new Error('the cache is a brick')
      })

      const failed = await fetch(`${base}/api/library`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      expect(failed.status).toBe(500)
      expect(await failed.json()).toEqual({ error: 'internal' })

      expect(
        (
          await fetch(`${base}/api/library`, {
            headers: { authorization: `Bearer ${TOKEN}` }
          })
        ).status
      ).toBe(200)
    } finally {
      warn.mockRestore()
    }
  })

  it('serves each request on its own connection state (no leaked socket)', async () => {
    // A second case touching the same server, so the 500 above cannot have
    // poisoned it — and so the suite proves the server is reusable
    const res = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Stopping: the port is refused afterwards (criterion 27's second half)
// ---------------------------------------------------------------------------

describe('stopping the API', () => {
  it('closes the listener, and the port refuses a new connection', async () => {
    // A **real** socket on a real port, because the criterion is what the
    // machine does: an assertion on the status record would pass while the
    // socket was still open, which is the failure this case exists to catch
    const started = await startRestApiIfEnabled({
      config: config({ port: 0, bind: '127.0.0.1' }),
      interfaces: MEASURED
    })
    expect(started.state).toBe('listening')

    const base = `http://127.0.0.1:${started.port as number}`
    const before = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(before.status).toBe(200)

    const stopped = await stopRestApi()
    expect(stopped).toMatchObject({
      state: 'disabled',
      address: null,
      port: null,
      reason: null
    })
    // The reporter slice 2's Settings row reads agrees with the return value
    expect(getRestApiStatus()).toEqual(stopped)

    // And the machine's own answer to "is it off?"
    await expect(
      fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
    ).rejects.toThrow()
  })

  it('is a settled no-op when nothing was started, and when stopped twice', async () => {
    // Today's shape: the flag is off, so nothing of ours is on the wire
    await startRestApiIfEnabled({
      config: config({ enabled: false }),
      interfaces: MEASURED,
      listen: recordingListen()
    })

    expect((await stopRestApi()).state).toBe('disabled')
    // Flipped twice — a switch, not an error
    expect((await stopRestApi()).state).toBe('disabled')
  })

  it('is a no-op after a refused bind, rather than a throw', async () => {
    const held = createServer()
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve))

    try {
      const refused = await startRestApiIfEnabled({
        config: config({ port: (held.address() as AddressInfo).port, bind: '127.0.0.1' }),
        interfaces: MEASURED
      })
      expect(refused.state).toBe('failed')

      // Nothing of ours reached the wire, so there is nothing to close
      expect((await stopRestApi()).state).toBe('disabled')
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()))
    }
  })

  it('a stop that arrives while the bind is in flight wins', async () => {
    // The race slice 2's toggle can actually hit: enable, then change your mind
    // before the bind has answered. The socket must not be opened *after* the
    // stop reported success — with nothing holding a reference to close it.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let bound = 0

    // A **real** listener held past a gate, so the stop lands in the window
    // between the server being created and the port being claimed
    const listen = vi.fn(async (server: Server) => {
      await gate
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      bound = (server.address() as AddressInfo).port
      return { ok: true as const, address: '127.0.0.1', port: bound }
    })

    const activation = startRestApiIfEnabled({
      config: config({ port: 0, bind: '127.0.0.1' }),
      interfaces: MEASURED,
      listen
    })

    expect((await stopRestApi()).state).toBe('disabled')

    // Now let the bind answer. It did bind — which is what gives the assertion
    // below something to refuse — and the activation that lost closes it.
    release()
    const settled = await activation

    expect(bound).toBeGreaterThan(0)
    expect(settled.state).toBe('disabled')
    expect(getRestApiStatus().state).toBe('disabled')
    await expect(
      fetch(`http://127.0.0.1:${bound}/api/health`, { signal: AbortSignal.timeout(2000) })
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The "never throws" claim, made structural rather than asserted (invariant 12)
// ---------------------------------------------------------------------------

describe('activation never rejects', () => {
  it('records a failure when the work inside throws, rather than rejecting', async () => {
    // The call site is `void startRestApiIfEnabled()` inside `app.whenReady`, so
    // a rejection is an unhandled rejection at start-up. This map throws from
    // the inside — the shape a lazily-opened database failing to migrate has.
    const hostile = {
      get utun9(): never {
        throw new Error('the interface table is a brick')
      }
    } as unknown as InterfaceMap

    const status = await startRestApiIfEnabled({
      config: config(),
      interfaces: hostile,
      listen: recordingListen()
    })

    expect(status.state).toBe('failed')
    expect(status.reason).toMatch(/activation failed/)
    // The cause is carried, because a status with no reason is a status slice 2
    // cannot show anybody
    expect(status.reason).toContain('the interface table is a brick')
  })
})

// ---------------------------------------------------------------------------
// The read surface: the library, a search, one book (AC9–AC12, AC16)
// ---------------------------------------------------------------------------

/**
 * A fixture library with the ties a page walk has to survive.
 *
 * Three books share an author and one has none at all, so a sort by author
 * leaves its key *equal* for three rows — which is exactly where a page walk
 * without the `id` tiebreak can serve a book twice or skip one. A fixture of
 * distinct keys cannot decide that either way.
 */
const FIXTURE: { id: string; title: string; author: string | null; rating: number | null }[] = [
  { id: 'lib-1', title: 'Alpha', author: 'Ursula K. Le Guin', rating: 5 },
  { id: 'lib-2', title: 'Bravo', author: 'Ursula K. Le Guin', rating: 3 },
  { id: 'lib-3', title: 'Charlie', author: 'Ursula K. Le Guin', rating: null },
  { id: 'lib-4', title: 'Delta', author: 'Seth Dickinson', rating: 5 },
  { id: 'lib-5', title: 'Echo', author: 'Adrian Tchaikovsky', rating: null },
  { id: 'lib-6', title: 'Foxtrot', author: 'Adrian Tchaikovsky', rating: 2 },
  { id: 'lib-7', title: 'Golf', author: null, rating: null }
]

function seedLibrary(): void {
  for (const book of FIXTURE) {
    db.insertBook({
      ...makeBook(book.id, book.title),
      author: book.author,
      rating: book.rating
    })
  }
}

describe('the library route', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    seedLibrary()
    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const auth = { authorization: `Bearer ${TOKEN}` }

  function get(path: string, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { headers: { ...auth, ...headers } })
  }

  interface Page {
    books: { id: string; title: string }[]
    total: number
    limit: number
    offset: number
  }

  async function page(path: string): Promise<Page> {
    const res = await get(path)
    expect(res.status).toBe(200)
    return (await res.json()) as Page
  }

  it('returns exactly `limit` rows, in the order the app itself lists them (AC9)', async () => {
    const sort: BookSort = { field: 'author', direction: 'asc' }
    // The app's own list, read through the same call its IPC handler makes
    const appOrder = db.getBooks({ sort }).map((b) => b.id)

    const first = await page('/api/library?sort=author&dir=asc&limit=3')

    expect(first.books.map((b) => b.id)).toEqual(appOrder.slice(0, 3))
    expect(first.books).toHaveLength(3)
    expect(first.total).toBe(appOrder.length)
    expect(first.limit).toBe(3)
    expect(first.offset).toBe(0)

    const second = await page('/api/library?sort=author&dir=asc&limit=3&offset=3')
    expect(second.books.map((b) => b.id)).toEqual(appOrder.slice(3, 6))
    // The total is the match count, not the page: it does not move with offset
    expect(second.total).toBe(appOrder.length)
    expect(second.offset).toBe(3)
  })

  it('walks every page to exhaustion with each id appearing exactly once (AC10)', async () => {
    // The fixture's ties are what this rests on; asserted so a later change to
    // the fixture cannot quietly turn this into a case about distinct keys
    const tied = db.getBooks({ sort: { field: 'author', direction: 'asc' } })
    expect(new Set(tied.map((b) => b.author)).size).toBeLessThan(tied.length)

    const walked: string[] = []
    for (let offset = 0; offset < tied.length; offset += 2) {
      const slice = await page(`/api/library?sort=author&dir=asc&limit=2&offset=${offset}`)
      walked.push(...slice.books.map((b) => b.id))
    }

    expect(walked).toEqual(tied.map((b) => b.id))
    expect(new Set(walked).size).toBe(walked.length)

    // And the page past the end is empty rather than a wrap-around: a client
    // walking with `offset < total` must stop on its own terms
    const past = await page(`/api/library?sort=author&limit=2&offset=${tied.length}`)
    expect(past.books).toEqual([])
    expect(past.total).toBe(tied.length)
  })

  it('answers a search with the app own ids, and the same count (AC11)', async () => {
    const expected = db.searchBooks('Ursula')

    const found = await page('/api/library?q=Ursula&limit=100')

    expect(expected.length).toBe(3)
    expect(found.books.map((b) => b.id)).toEqual(expected.map((b) => b.id))
    expect(found.total).toBe(expected.length)

    // A search the library does not hold is an empty page, not a 404
    const none = await page('/api/library?q=zzzznotabook')
    expect(none.books).toEqual([])
    expect(none.total).toBe(0)
  })

  it('orders a search by relevance, not by title, when no `sort` is asked for (AC11)', async () => {
    // The document states this default, so this case is what decides it. The two ids are
    // chosen so that the two candidate orders disagree *and* a rank tie would not pass:
    // id order and title order both put `rel-a` first, so only genuine relevance puts
    // `rel-z` there. The term is in `rel-z`'s title and once in `rel-a`'s long
    // description, which is what bm25 scores lower.
    db.insertBook({
      ...makeBook('rel-a', 'Aardvark'),
      description: `A deliberately long description that mentions an aardwolf exactly once, padded out with plenty of other words so that the column is long enough for a single occurrence to score below the same word in a two-word title`
    })
    db.insertBook({ ...makeBook('rel-z', 'Zulu Aardwolf'), description: 'unrelated text' })
    try {
      const found = await page('/api/library?q=aardwolf&limit=10')
      expect(found.total).toBe(2)
      expect(found.books.map((b) => b.id)).toEqual(['rel-z', 'rel-a'])
    } finally {
      db.deleteBook('rel-a')
      db.deleteBook('rel-z')
    }
  })

  it('breaks a tie on the sort key by ascending id, which is what a walk over ties needs (AC10)', async () => {
    // The fixture's tied rows were inserted in id order, so their rowid order and their id
    // order agree — which means a missing tiebreak is invisible to the walk above. These
    // three share an author and go in *descending* id order, so the two orders disagree:
    // without `id ASC` this page comes back tie-c, tie-b, tie-a, and a walk over equal
    // keys is free to repeat a book or skip one.
    const tied = ['tie-c', 'tie-b', 'tie-a']
    for (const id of tied) db.insertBook({ ...makeBook(id, `Tied ${id}`), author: 'Tied Author' })
    try {
      const slice = await page('/api/library?authors=Tied%20Author&sort=author&limit=3')
      expect(slice.total).toBe(3)
      expect(slice.books.map((b) => b.id)).toEqual(['tie-a', 'tie-b', 'tie-c'])
    } finally {
      for (const id of tied) db.deleteBook(id)
    }
  })

  it('does not page `getBooks()` behind the wire default (AC12)', async () => {
    // Every other case here runs on a seven-book fixture, so a default `LIMIT 100` added
    // to the shared statement would be invisible. 101 rows make `DEFAULT_PAGE_LIMIT` the
    // number that would show up — in the app's own library view, not just on the wire.
    const bulk = Array.from({ length: 101 }, (_, i) => `bulk-${String(i).padStart(3, '0')}`)
    for (const id of bulk) db.insertBook(makeBook(id, `Bulk ${id}`))
    try {
      expect(db.getBooks()).toHaveLength(FIXTURE.length + bulk.length)

      // And a page asked for more than the library holds still serves all of it
      const all = await page('/api/library?limit=500')
      expect(all.total).toBe(FIXTURE.length + bulk.length)
      expect(all.books).toHaveLength(FIXTURE.length + bulk.length)
    } finally {
      for (const id of bulk) db.deleteBook(id)
    }
  })

  it('leaves the unpaginated path exactly as it was (AC12)', async () => {
    // `getBooks()` with no page argument is the statement the app's own call
    // sites run — no LIMIT, no OFFSET — and it is the decider for this slice
    // not having changed the library view. The pages are slices of that same
    // order, which is the other half of the claim.
    const unpaged = db.getBooks()
    expect(unpaged).toHaveLength(FIXTURE.length)

    const ids = unpaged.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)

    expect(db.countBooks()).toBe(unpaged.length)

    // The route's own default: no `limit` parameter means the contract's 100,
    // and it still serves the whole fixture
    const defaulted = await page('/api/library')
    expect(defaulted.limit).toBe(100)
    expect(defaulted.books.map((b) => b.id)).toEqual(ids)
  })

  it('caps limit at the contract maximum rather than refusing it (D7)', async () => {
    const capped = await page('/api/library?limit=900')
    expect(capped.limit).toBe(500)
    expect(capped.books).toHaveLength(FIXTURE.length)
  })

  it('narrows the list with the same filters the app has, and counts what it narrowed to', async () => {
    const byAuthor = await page('/api/library?authors=Ursula K. Le Guin')
    expect(byAuthor.total).toBe(3)
    // Repeated and comma-separated values are the same request
    const byTwoAuthors = await page('/api/library?authors=Ursula K. Le Guin,Seth Dickinson')
    expect(byTwoAuthors.total).toBe(4)

    const rated = await page('/api/library?minRating=5')
    expect(rated.total).toBe(2)
    expect(rated.books.map((b) => b.title).sort()).toEqual(['Alpha', 'Delta'])

    const filtered = await page('/api/library?authors=Ursula K. Le Guin&minRating=5')
    expect(filtered.books.map((b) => b.title)).toEqual(['Alpha'])

    const searched = await page('/api/library?q=Ursula&minRating=3')
    expect(searched.total).toBe(2)
  })

  it('sorts date_added newest-first unless told otherwise (the field direction rule)', async () => {
    // The rule is `defaultSortDirection`, the same one the app's own sort
    // control uses on a first click — asserted here so the two cannot drift
    const newest = await page('/api/library?sort=date_added')
    expect(newest.books.map((b) => b.id)).toEqual(
      db.getBooks({ sort: { field: 'date_added', direction: 'desc' } }).map((b) => b.id)
    )
    const ascent = await page('/api/library?sort=date_added&dir=asc')
    expect(ascent.books.map((b) => b.id)).toEqual(
      db.getBooks({ sort: { field: 'date_added', direction: 'asc' } }).map((b) => b.id)
    )
  })

  it('answers 400 with the contract body for a malformed parameter', async () => {
    // **The full table moved with the function.** `parseLibraryQuery` is a pure
    // function of a `URL` now, and its ten malformed-parameter cases are decided
    // in `services/api/query.test.ts` without a socket (the split the pre-merge
    // review handed to this slice). What only a wire can decide is that the
    // refusal reaches a client as a status with the contract's own body.
    const res = await get('/api/library?sort=athor')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('answers 404 for an unknown book and 200 for a known one', async () => {
    const missing = await get('/api/books/not-a-book')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })

    const found = await get('/api/books/lib-1')
    expect(found.status).toBe(200)
    const book = (await found.json()) as { id: string; title: string; cover: unknown }
    expect(book).toMatchObject({ id: 'lib-1', title: 'Alpha' })
    // The detail payload is the list's payload: one shaper, so the two cannot
    // describe a book differently
    expect(await (await get('/api/library?q=Alpha')).json()).toMatchObject({
      books: [book]
    })
  })

  it('answers the filter counts the app itself computes', async () => {
    const res = await get('/api/library/facets')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(db.getFacets())
  })

  it('answers HEAD on the JSON routes with the headers and no body (the method policy)', async () => {
    // `URLSession` probes with HEAD, and 1a's GET-only switch answered 404 where
    // a connect check belongs. `node:http` suppresses the body and keeps the
    // headers, so the probe sees exactly what the GET would have said.
    const body = await (await get('/api/health')).text()

    const probe = await fetch(`${base}/api/health`, { method: 'HEAD', headers: auth })
    expect(probe.status).toBe(200)
    expect(probe.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(probe.headers.get('content-length')).toBe(String(Buffer.byteLength(body)))
    expect(await probe.text()).toBe('')

    // The other three JSON routes answer it too, and auth still runs first
    for (const path of ['/api/library', '/api/library/facets', '/api/books/lib-1']) {
      expect((await fetch(`${base}${path}`, { method: 'HEAD', headers: auth })).status).toBe(200)
    }
    expect((await fetch(`${base}/api/health`, { method: 'HEAD' })).status).toBe(401)
  })

  it('answers 404 for a known path behind a method it does not answer', async () => {
    // Uniform and reason-free: a client cannot tell "no such route" from "wrong
    // method", which is the same rule the `musaeum://` routes follow
    expect((await fetch(`${base}/api/library`, { method: 'POST', headers: auth })).status).toBe(404)
    expect((await fetch(`${base}/api/library`, { method: 'DELETE', headers: auth })).status).toBe(
      404
    )
  })

  it('answers from the cache while the share is unmounted, and never touches it (AC16)', async () => {
    // The fixture's `isOnline` is false and no library root is configured, which
    // is the strongest form of "the NAS is unreachable": the read path still
    // answers, because it is a query and not a file read. The byte routes'
    // answer to the same state is 503 (asserted in the next describe).
    expect(nas.isOnline()).toBe(false)
    expect(nas.getLibraryRoot()).toBeNull()

    expect(await page('/api/library?limit=2')).toMatchObject({ total: FIXTURE.length })
    expect((await get('/api/library/facets')).status).toBe(200)
    expect((await get('/api/books/lib-1')).status).toBe(200)
    expect((await get('/api/health')).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// The shelf reads: the list, the scope, and the member (bookshelves D10, AC30)
// ---------------------------------------------------------------------------

describe('the shelf reads', () => {
  let server: Server
  let base: string
  let root: string
  let shelfId: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-rest-shelves-'))
    await nas.setLibraryRoot(root) // a temp dir that exists → the share is 'connected'
    vi.mocked(nas.isOnline).mockReturnValue(true)

    seedLibrary()
    // The real service, not a hand-written file: the case's shelf is the one
    // every other path in the app would see
    shelfId = (await shelves.create('To Read', ['lib-1', 'lib-3'])).id

    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  const auth = { authorization: `Bearer ${TOKEN}` }
  const get = (path: string) => fetch(`${base}${path}`, { headers: auth })

  it('answers the shelf list, alphabetically, with the count and the shelf own clock', async () => {
    const res = await get('/api/shelves')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { shelves: unknown[] }
    // The payload is the db read, shaped — never a count computed here
    expect(body.shelves).toEqual(db.listShelvesWithUpdatedAt())
    expect(body.shelves).toHaveLength(1)
  })

  it('answers HEAD on /api/shelves with the headers and no body (the method policy)', async () => {
    const probe = await fetch(`${base}/api/shelves`, { method: 'HEAD', headers: auth })

    expect(probe.status).toBe(200)
    expect(probe.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await probe.text()).toBe('')
  })

  it('scopes the page, its total, its default order and its search (AC30)', async () => {
    type Page = { books: { id: string }[]; total: number }

    const scoped = await get(`/api/library?shelf=${shelfId}`)
    expect(scoped.status).toBe(200)
    const page = (await scoped.json()) as Page
    expect(page.total).toBe(2)
    expect(page.books.map((b) => b.id).sort()).toEqual(['lib-1', 'lib-3'])

    // The default order inside a shelf is Date Added to Shelf, descending —
    // compared against the same query with that sort named, not re-derived here
    const named = (await (
      await get(`/api/library?shelf=${shelfId}&sort=shelf_added&dir=desc`)
    ).json()) as Page
    expect(page.books.map((b) => b.id)).toEqual(named.books.map((b) => b.id))

    // A search inside the shelf searches the shelf: Charlie is on it, Bravo is not
    const inside = (await (await get(`/api/library?shelf=${shelfId}&q=Charlie`)).json()) as Page
    expect(inside.total).toBe(1)
    expect(inside.books.map((b) => b.id)).toEqual(['lib-3'])
    const outside = (await (await get(`/api/library?shelf=${shelfId}&q=Bravo`)).json()) as Page
    expect(outside.total).toBe(0)
  })

  it('carries the member on the page and the detail, and [] on a book no shelf holds', async () => {
    const page = (await (await get(`/api/library?shelf=${shelfId}`)).json()) as {
      books: { id: string; shelves: string[] }[]
    }
    expect(page.books.every((b) => b.shelves.includes(shelfId))).toBe(true)

    const detail = (await (await get('/api/books/lib-1')).json()) as { shelves: string[] }
    expect(detail.shelves).toEqual([shelfId])

    const unshelved = (await (await get('/api/books/lib-2')).json()) as { shelves: string[] }
    expect(unshelved.shelves).toEqual([])
  })

  it('scopes the facets through the same builder the page uses', async () => {
    const res = await get(`/api/library/facets?shelf=${shelfId}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(db.getFacets({ shelfId }))
  })

  it('answers 404 for an unknown shelf on both scoped routes, and never a 200', async () => {
    for (const path of [
      '/api/library?shelf=no-such-shelf',
      '/api/library/facets?shelf=no-such-shelf'
    ]) {
      const res = await get(path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
  })

  it('answers 400 for an empty shelf and for shelf_added with no shelf to order by (S4, S5)', async () => {
    for (const path of [
      '/api/library?shelf=',
      '/api/library/facets?shelf=',
      '/api/library?sort=shelf_added'
    ]) {
      const res = await get(path)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad request' })
    }
  })

  it('answers the reads from the cache while the share is unmounted (D10)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)

    expect((await get('/api/shelves')).status).toBe(200)
    expect((await get(`/api/library?shelf=${shelfId}`)).status).toBe(200)
    expect((await get(`/api/library/facets?shelf=${shelfId}`)).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// The shelf membership writes (bookshelves D10, AC31)
// ---------------------------------------------------------------------------

describe('the shelf membership writes', () => {
  let server: Server
  let base: string
  let root: string
  let shelfId: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-rest-membership-'))
    await nas.setLibraryRoot(root)
    vi.mocked(nas.isOnline).mockReturnValue(true)

    seedLibrary()
    shelfId = (await shelves.create('To Read', ['lib-1'])).id

    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  const auth = { authorization: `Bearer ${TOKEN}` }
  const path = (bookId: string) => `/api/shelves/${shelfId}/books/${bookId}`
  const put = (bookId: string) => fetch(`${base}${path(bookId)}`, { method: 'PUT', headers: auth })
  const del = (bookId: string) =>
    fetch(`${base}${path(bookId)}`, { method: 'DELETE', headers: auth })

  /** The shelf as the canonical file holds it now. */
  async function shelfOnDisk(): Promise<ManualShelfEntry | undefined> {
    const read = await readShelvesFile(root)
    if (read.state !== 'ok') return undefined
    return read.file.shelves.find(
      (s): s is ManualShelfEntry => s.kind === 'manual' && s.id === shelfId
    )
  }

  it('adds on PUT, and answers the book as it stands after the write (AC31, S8)', async () => {
    const res = await put('lib-2')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { book } = (await res.json()) as { book: { id: string; shelves: string[] } }
    expect(book.id).toBe('lib-2')
    expect(book.shelves).toContain(shelfId)
    // The write and the read that follows it are one round trip: the answer is
    // the detail payload
    expect(book).toEqual(await (await fetch(`${base}/api/books/lib-2`, { headers: auth })).json())

    // And it reached the canonical file, not only the cache
    expect((await shelfOnDisk())?.books.map((m) => m.id)).toContain('lib-2')
  })

  it('is idempotent: a second PUT answers 200 and keeps the first added_at (AC31)', async () => {
    await put('lib-2')
    const first = (await shelfOnDisk())?.books.find((m) => m.id === 'lib-2')?.added_at

    const again = await put('lib-2')

    expect(again.status).toBe(200)
    expect((await again.json()) as object).toMatchObject({ book: { shelves: [shelfId] } })
    expect(first).toBeTruthy()
    expect((await shelfOnDisk())?.books.find((m) => m.id === 'lib-2')?.added_at).toBe(first)
  })

  it('removes on DELETE, and a DELETE of a non-member is a success too (AC31)', async () => {
    // lib-1 is on the shelf from the setup
    const res = await del('lib-1')

    expect(res.status).toBe(200)
    const { book } = (await res.json()) as { book: { id: string; shelves: string[] } }
    expect(book.id).toBe('lib-1')
    expect(book.shelves).toEqual([])
    expect((await shelfOnDisk())?.books.map((m) => m.id)).not.toContain('lib-1')

    const again = await del('lib-1')
    expect(again.status).toBe(200)
    expect((await again.json()) as object).toMatchObject({ book: { shelves: [] } })
  })

  it('answers 404 for an unknown shelf and an unknown book, and writes nothing', async () => {
    const unknownShelf = await fetch(`${base}/api/shelves/no-such-shelf/books/lib-2`, {
      method: 'PUT',
      headers: auth
    })
    expect(unknownShelf.status).toBe(404)
    expect(await unknownShelf.json()).toEqual({ error: 'not found' })

    const unknownBook = await put('not-a-book')
    expect(unknownBook.status).toBe(404)
    expect(await unknownBook.json()).toEqual({ error: 'not found' })

    // Neither attempt changed the shelf
    expect((await shelfOnDisk())?.books.map((m) => m.id)).toEqual(['lib-1'])
  })

  it('answers 503 library offline before anything is attempted (AC31, S10)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)

    const res = await put('lib-2')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error: 'library offline' })
    // Refused before the service ran: the file holds exactly what it held
    expect((await shelfOnDisk())?.books.map((m) => m.id)).toEqual(['lib-1'])
  })

  it('answers 404 to every method but PUT and DELETE on the path (S9)', async () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH']) {
      const res = await fetch(`${base}${path('lib-2')}`, { method, headers: auth })
      expect(res.status).toBe(404)
    }
    expect((await shelfOnDisk())?.books.map((m) => m.id)).toEqual(['lib-1'])
  })

  it('answers 500 and never overwrites a shelves.json that cannot be read (S2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const before = 'not json at all'
      writeFileSync(join(root, 'shelves.json'), before, 'utf8')

      const res = await put('lib-2')

      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'internal' })
      expect(readFileSync(join(root, 'shelves.json'), 'utf8')).toBe(before)
      // **The service's own sentence reaches the log**, which is the other half
      // of this route's claim — the wire gets the fixed word while the reason
      // goes where a person can read it (`docs/invariants/shelves.md`). Part
      // 5b's review flagged that this case silenced the warn without asserting
      // it, so the claim was code-read rather than decided, until now.
      const lines = warn.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes(shelves.SHELVES_UNREADABLE))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('answers 503, not 500, when the share drops between the check and the write (S10)', async () => {
    // **The window this route cannot close** (part 5b's review, finding 4): the
    // handler's pre-check sees a share, the service's own `assertOnline` does
    // not. Nothing is written in that window either way; what differs is the
    // answer, and the contract's for a share that cannot take a write is 503
    // `library offline` with `Retry-After` — not this module's 500, which would
    // tell a client to give up rather than to come back.
    //
    // Both stubs are halves of the **same fact** — the share went away between
    // the two gates: `isOnline` answers `true` for the pre-check's own call and
    // `false` after it (`beforeEach` has already seeded the shelf through this
    // gate, so the first call here is the handler's), and the service's gate
    // throws the way it would with the share gone.
    vi.mocked(nas.isOnline).mockReturnValueOnce(true).mockReturnValue(false)
    vi.mocked(nas.assertOnline).mockImplementationOnce(() => {
      throw new Error('library offline')
    })

    const res = await put('lib-2')

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error: 'library offline' })
    expect((await shelfOnDisk())?.books.map((m) => m.id)).toEqual(['lib-1'])
  })

  it('broadcasts shelvesChanged, so the Mac sidebar follows a phone write (D10)', async () => {
    const heard: string[] = []
    const unsubscribe = subscribe((event) => {
      if (event === 'shelvesChanged') heard.push(event)
    })
    try {
      await put('lib-2')
      expect(heard).toContain('shelvesChanged')
    } finally {
      unsubscribe()
    }
  })
})

// ---------------------------------------------------------------------------
// The one write: PUT /api/books/{id}/reading (AC20–AC24)
// ---------------------------------------------------------------------------

/**
 * The route over a real socket, and the same shape of case the rest of this
 * file uses. What is *not* here is the rules themselves: the fraction/position
 * split, the stale-report comparison, the status parity and the offline park are
 * `services/api/reading.test.ts`'s — this describe decides what only a wire can,
 * which is what a client gets for each one of them (a status, a body, and a
 * `new URL`'s worth of ordering).
 */
describe('the reading report', () => {
  let server: Server
  let base: string

  /** The row as the database holds it, for the assertions that are about columns. */
  function rawRow(id: string): Record<string, unknown> {
    return db.getDb().prepare('SELECT * FROM books WHERE id = ?').get(id) as Record<string, unknown>
  }

  beforeEach(async () => {
    db.insertBook(makeBook('w-one', 'One'))
    db.insertBook({ ...makeBook('w-read', 'Read'), readStatus: 'read' })

    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const auth = { authorization: `Bearer ${TOKEN}` }

  function put(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  }

  function get(path: string) {
    return fetch(`${base}${path}`, { headers: auth })
  }

  interface ReportAnswer {
    applied: boolean
    book: { id: string; reading: { status: string; percent: number | null } }
  }

  it('writes the fraction, blanks the position, and answers the book it wrote (AC20)', async () => {
    const res = await put('/api/books/w-one/reading', { percent: 0.6 })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')

    const answer = (await res.json()) as ReportAnswer
    expect(answer.applied).toBe(true)
    expect(answer.book).toMatchObject({
      id: 'w-one',
      reading: { status: 'reading', percent: 0.6 }
    })
    // The state a client resumes from is the state it just wrote: the payload
    // is the same shaper the detail route answers with, so the two cannot
    // describe the book differently
    expect(answer.book).toEqual(await (await get('/api/books/w-one')).json())

    // The columns, not the payload: the fraction landed and the CFI column is
    // null — the phone writes the fraction, the position stays the Mac's (D5)
    const row = rawRow('w-one')
    expect(row.reading_percent).toBe(0.6)
    expect(row.reading_position).toBeNull()
  })

  it('answers applied: false and writes nothing when the report is older than the row (AC21)', async () => {
    db.setReadingState('w-one', {
      position: 'epubcfi(/6/2!/4)',
      percent: 0.5,
      updatedAt: '2026-09-22T09:00:00.000Z'
    })
    const before = JSON.stringify(rawRow('w-one'))

    const res = await put('/api/books/w-one/reading', {
      percent: 0.05,
      at: '2026-09-01T09:00:00.000Z'
    })

    expect(res.status).toBe(200)
    const answer = (await res.json()) as ReportAnswer
    expect(answer.applied).toBe(false)
    // D6's "with the current state": the client can resume from the answer
    // without a second request, and the row is untouched
    expect(answer.book.reading.percent).toBe(0.5)
    expect(JSON.stringify(rawRow('w-one'))).toBe(before)
  })

  it('advances read_status exactly as the Mac own writes do (AC22)', async () => {
    const finished = await put('/api/books/w-one/reading', { percent: 0.99 })
    expect(((await finished.json()) as ReportAnswer).book.reading.status).toBe('read')

    // …and a book already marked read is not sent back to Reading by a phone
    // that reopened it at the front
    const reopened = await put('/api/books/w-read/reading', { percent: 0.05 })
    expect(((await reopened.json()) as ReportAnswer).book.reading.status).toBe('read')
    expect(db.getBook('w-read')?.readStatus).toBe('read')
  })

  it('answers 200 and lands in SQLite while the share is unmounted (AC23)', async () => {
    // The fixture's `isOnline` is false and no library root is configured,
    // which is the strongest form of "the NAS is unreachable" — and a report is
    // not a byte request: it is a row write, and the parking/flush it buys is
    // `services/api/reading.test.ts`'s case
    expect(nas.isOnline()).toBe(false)
    expect(nas.getLibraryRoot()).toBeNull()

    const res = await put('/api/books/w-one/reading', { percent: 0.3 })

    expect(res.status).toBe(200)
    expect(((await res.json()) as ReportAnswer).applied).toBe(true)
    expect(db.getBook('w-one')?.readingState?.percent).toBe(0.3)
  })

  it('answers 404 for an unknown book and writes nothing (AC24)', async () => {
    const res = await put('/api/books/not-a-book/reading', { percent: 0.5 })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
    expect(db.getBook('not-a-book')).toBeNull()
    // The refusal reached the same place the cover and file routes' unknown-id
    // refusals do, and the book that exists is untouched
    expect(db.getBook('w-one')?.readingState).toBeNull()
  })

  it.each([
    ['a body that is not JSON', '{'],
    ['an empty body', ''],
    ['a bare null', 'null'],
    ['an array', '[0.5]'],
    ['a bare number', '0.5'],
    ['no percent member', '{}'],
    ['a string percent', '{"percent":"0.6"}'],
    ['a percent above the range', '{"percent":1.5}'],
    ['a percent below the range', '{"percent":-0.1}'],
    ['a whole number of percent', '{"percent":60}'],
    ['an `at` that is not a timestamp', '{"percent":0.5,"at":"yesterday"}'],
    ['an explicit null `at`', '{"percent":0.5,"at":null}'],
    ['a body larger than the route reads', `{"percent":0.5,"pad":"${'x'.repeat(5000)}"}`]
  ])('answers 400 for %s, and nothing is written', async (_label, body) => {
    // Refused rather than clamped or defaulted — the read routes' own discipline
    // for a malformed parameter (`?sort=athor` is a 400 too), and never a 500
    // for the client's own mistake
    const res = await put('/api/books/w-one/reading', body)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
    expect(db.getBook('w-one')?.readingState).toBeNull()
  })

  it('refuses a malformed body 400 even for an id that does not exist, the order the contract states', async () => {
    // The body is validated *before* the book is looked up, so a request this
    // surface cannot parse is refused as such rather than as a missing book —
    // the same order the cover route validates `size` in, and the reason the
    // contract's sentence is a promise rather than a description. Decided: the
    // two halves separately (a 400 for a known id, a 404 for a valid body)
    // leave this combination unclaimed.
    const res = await put('/api/books/not-a-book/reading', '{')

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('answers a body that never finishes, rather than waiting on a client that declared more than it sent', async () => {
    // A raw socket, because `fetch` cannot lie about `Content-Length`. Measured
    // before the fix (pre-merge review, finding 6): no response *and* no
    // server-side close in 8 s — the request was never answered at all, which is
    // the failure `BODY_TIMEOUT_MS` exists to bound. The seam is what lets this
    // case decide it in 150ms instead of ten seconds.
    const lying = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }), {
      bodyTimeoutMs: 150
    })
    await new Promise<void>((resolve) => lying.listen(0, '127.0.0.1', resolve))
    const { port } = lying.address() as AddressInfo

    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
    socket.write(
      `PUT /api/books/w-one/reading HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"per'
    )

    const answer = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no answer within 2s of a 150ms body timeout')),
        2_000
      )
      let text = ''
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        if (text.includes('\r\n\r\n')) {
          clearTimeout(timer)
          resolve(text)
        }
      })
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    expect(answer).toContain('400 Bad Request')
    // Refused before anything was written, which is the whole point of bounding it
    expect(db.getBook('w-one')?.readingState).toBeNull()

    socket.destroy()
    await new Promise<void>((resolve) => lying.close(() => resolve()))
  })

  it('is behind the same auth check as every other route (AC2)', async () => {
    const bare = await fetch(`${base}/api/books/w-one/reading`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ percent: 0.5 })
    })

    expect(bare.status).toBe(401)
    expect(bare.headers.get('www-authenticate')).toBe('Bearer')
    expect(db.getBook('w-one')?.readingState).toBeNull()
  })

  it('answers 404 for a GET of the write route, and for every other method (D11)', async () => {
    // A known path behind a method it does not answer is the same answer as no
    // path at all — the client cannot map this surface's methods
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'PATCH']) {
      const res = await fetch(`${base}/api/books/w-one/reading`, { method, headers: auth })
      expect(res.status).toBe(404)
    }
    expect(db.getBook('w-one')?.readingState).toBeNull()
  })

  it('does not require a content-type, and ignores members it does not know', async () => {
    // Nothing in this surface reads a content-type (no route does), and D5's
    // whole point is that a position sent anyway is ignored — not stored, not
    // refused. The report is read by its own field list.
    const res = await put(
      '/api/books/w-one/reading',
      { percent: 0.42, position: 'epubcfi(/6/14!/4/2/2[c01]/1:0)', bogus: true },
      { 'content-type': 'text/plain' }
    )

    expect(res.status).toBe(200)
    const answer = (await res.json()) as ReportAnswer
    expect(answer.applied).toBe(true)
    // The CFI the client sent is nowhere: not in the row, not in the payload
    expect(rawRow('w-one').reading_position).toBeNull()
    expect(JSON.stringify(answer)).not.toContain('epubcfi')
  })
})

// ---------------------------------------------------------------------------
// Bytes: covers, files, ranges and the transfer budget (AC14, AC15, AC15a, AC17)
// ---------------------------------------------------------------------------

describe('the byte routes', () => {
  let server: Server
  let base: string
  let root: string
  let epub: string
  let thumb: string
  let full: string

  /** Deterministic, non-repeating bytes: a head served for a tail cannot match. */
  const BOOK_BYTES = Buffer.alloc(4096)
  for (let i = 0; i < BOOK_BYTES.length; i++) BOOK_BYTES[i] = (i * 7 + 13) % 251
  const THUMB_BYTES = Buffer.from('cover_thumb.jpg bytes — deliberately short')
  const FULL_BYTES = Buffer.from('a different image for cover_full.jpg, and longer than the thumb')

  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'musaeum-rest-bytes-'))
    await nas.setLibraryRoot(root)
    // `setLibraryRoot` runs the real health check and the share *is* there, but
    // the module's `isOnline` is the mock the suite installed
    vi.mocked(nas.isOnline).mockReturnValue(true)

    const dir = join(root, 'books', 'epub-1')
    mkdirSync(dir, { recursive: true })
    epub = join(dir, 'Leviathan Wakes.epub')
    thumb = join(dir, 'cover_thumb.jpg')
    full = join(dir, 'cover_full.jpg')
    writeFileSync(epub, BOOK_BYTES)
    writeFileSync(thumb, THUMB_BYTES)
    writeFileSync(full, FULL_BYTES)

    // The row's title and the file's name disagree on purpose: nothing resolves
    // by canonical filename, and a book renamed after import still serves
    db.insertBook({
      ...makeBook('epub-1', 'Some Older Title'),
      formats: ['epub'],
      coverThumbPath: 'cover_thumb.jpg',
      coverFullPath: 'cover_full.jpg'
    })
    db.insertBook({ ...makeBook('no-cover'), formats: ['epub'] })
    db.insertBook({ ...makeBook('traversing'), nasPath: '../outside', formats: ['epub'] })
    db.insertBook({ ...makeBook('bad-cover'), formats: ['mobi'], coverThumbPath: '../secret.jpg' })

    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  const auth = { authorization: `Bearer ${TOKEN}` }

  function get(path: string, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { headers: { ...auth, ...headers } })
  }

  it('serves a cover byte-identical to the file on disk (AC13/AC14)', async () => {
    const res = await get('/api/books/epub-1/cover?size=thumb')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-length')).toBe(String(THUMB_BYTES.length))
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(sha256(readFileSync(thumb)))
  })

  it('serves the size asked for, and the full cover by default', async () => {
    const asked = await get('/api/books/epub-1/cover?size=full')
    expect(sha256(Buffer.from(await asked.arrayBuffer()))).toBe(sha256(readFileSync(full)))

    const defaulted = await get('/api/books/epub-1/cover')
    expect(sha256(Buffer.from(await defaulted.arrayBuffer()))).toBe(sha256(readFileSync(full)))
  })

  it('answers 400 for a size that is neither thumb nor full — stricter than the handler (AC14)', async () => {
    const res = await get('/api/books/epub-1/cover?size=banana')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('answers 404 for a book with no cover of that size, and for an unknown book', async () => {
    expect((await get('/api/books/no-cover/cover?size=thumb')).status).toBe(404)
    expect((await get('/api/books/not-a-book/cover?size=thumb')).status).toBe(404)
  })

  it('answers 400 for a traversing cover path — the handler split, carried through (AC14)', async () => {
    const res = await get('/api/books/bad-cover/cover?size=thumb')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad request' })
  })

  it('serves a book file byte-identical to the disk, with its length and type (AC15)', async () => {
    const res = await get('/api/books/epub-1/file?format=epub')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/epub+zip')
    expect(res.headers.get('content-length')).toBe(String(BOOK_BYTES.length))
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    const served = Buffer.from(await res.arrayBuffer())
    expect(served).toHaveLength(BOOK_BYTES.length)
    expect(sha256(served)).toBe(sha256(readFileSync(epub)))
  })

  it.each([
    ['a missing format \u2192 400', '/api/books/epub-1/file', 400],
    ['an unknown format \u2192 404', '/api/books/epub-1/file?format=sh', 404],
    ['a format it does not have \u2192 404', '/api/books/epub-1/file?format=mobi', 404],
    ['an unknown book \u2192 404', '/api/books/not-a-book/file?format=epub', 404],
    ['a traversing nasPath \u2192 404', '/api/books/traversing/file?format=epub', 404]
  ])('answers %s (AC15)', async (_label, path, status) => {
    const res = await get(path)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ error: status === 400 ? 'bad request' : 'not found' })
  })

  it('serves the media type that matches the format it resolved', async () => {
    // The book has one file: epub. Its type is asserted above; this is the same
    // route answering a *different* declared format, so the mapping is decided
    // by the format asked for and not by the file's extension on disk
    db.insertBook({ ...makeBook('pdf-1'), formats: ['pdf'] })
    const dir = join(root, 'books', 'pdf-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Book.pdf'), 'not really a pdf')

    const res = await get('/api/books/pdf-1/file?format=pdf')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('answers 503 with Retry-After while the share is unmounted (D11)', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)

    for (const path of [
      '/api/books/epub-1/cover?size=thumb',
      '/api/books/epub-1/file?format=epub'
    ]) {
      const res = await get(path)
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
      expect(await res.json()).toEqual({ error: 'library offline' })
    }
  })

  it('answers 404 to a HEAD on a byte route: they are GET-only (D15)', async () => {
    expect(
      (await fetch(`${base}/api/books/epub-1/file?format=epub`, { method: 'HEAD', headers: auth }))
        .status
    ).toBe(404)
  })

  it('serves the tail from N, hashed against the file itself (AC15a)', async () => {
    const N = 1000
    const onDisk = readFileSync(epub)

    const res = await get('/api/books/epub-1/file?format=epub', { range: `bytes=${N}-` })
    const tail = Buffer.from(await res.arrayBuffer())

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(
      `bytes ${N}-${onDisk.length - 1}/${onDisk.length}`
    )
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(onDisk.length - N))

    // The criterion, and why it is a *tail* hash: a server that ignored the
    // Range and re-sent the head answers 206-shaped bytes of exactly the same
    // length, so the hash is taken against `subarray(N)` — and the second line
    // is what makes this case able to tell the two apart.
    expect(sha256(tail)).toBe(sha256(onDisk.subarray(N)))
    expect(sha256(tail)).not.toBe(sha256(onDisk.subarray(0, onDisk.length - N)))
  })

  it('serves a closed range, clamped to the last byte (D15)', async () => {
    const onDisk = readFileSync(epub)

    const closed = await get('/api/books/epub-1/file?format=epub', { range: 'bytes=10-19' })
    expect(closed.status).toBe(206)
    expect(closed.headers.get('content-range')).toBe(`bytes 10-19/${onDisk.length}`)
    expect(sha256(Buffer.from(await closed.arrayBuffer()))).toBe(sha256(onDisk.subarray(10, 20)))

    const past = await get('/api/books/epub-1/file?format=epub', {
      range: `bytes=${onDisk.length - 5}-${onDisk.length + 500}`
    })
    expect(past.headers.get('content-range')).toBe(
      `bytes ${onDisk.length - 5}-${onDisk.length - 1}/${onDisk.length}`
    )
    expect(sha256(Buffer.from(await past.arrayBuffer()))).toBe(
      sha256(onDisk.subarray(onDisk.length - 5))
    )
  })

  it('answers 416 with the length for a range the file cannot satisfy (D15)', async () => {
    const onDisk = readFileSync(epub)
    const res = await get('/api/books/epub-1/file?format=epub', {
      range: `bytes=${onDisk.length}-`
    })

    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${onDisk.length}`)
    expect(await res.json()).toEqual({ error: 'range not satisfiable' })
  })

  it.each([['bytes=-500'], ['bytes=0-1,5-6'], ['bytes=abc']])(
    'answers 416 for a malformed range rather than re-sending the head (%s)',
    async (range) => {
      // Deliberately stricter than HTTP's latitude: an ignored Range here means
      // half a gigabyte re-sent to a client that asked for a tail
      const res = await get('/api/books/epub-1/file?format=epub', { range })
      expect(res.status).toBe(416)
    }
  )

  it('answers a Range against a 0-byte file 416, and 200 without one (D15)', async () => {
    // A half-failed write leaves a 0-byte file, which is exactly the shape a resuming
    // client can meet. `bytes=<total>-` is unsatisfiable at every offset, so an empty 200
    // would read as a finished download — the file had to stop answering before the range
    // was consulted.
    const dir = join(root, 'books', 'empty-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Empty.epub'), Buffer.alloc(0))
    db.insertBook({ ...makeBook('empty-1', 'Empty'), formats: ['epub'] })

    const whole = await get('/api/books/empty-1/file?format=epub')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-length')).toBe('0')
    expect((await whole.arrayBuffer()).byteLength).toBe(0)

    for (const range of ['bytes=0-', 'bytes=5-']) {
      const ranged = await get('/api/books/empty-1/file?format=epub', { range })
      expect(ranged.status).toBe(416)
      expect(ranged.headers.get('content-range')).toBe('bytes */0')
      expect(await ranged.json()).toEqual({ error: 'range not satisfiable' })
    }
  })

  it('holds at most two transfers, answers the third 503, and leaves the app alone (AC17)', async () => {
    const releases: (() => void)[] = []
    /** Flipped false once the case has decided the cap: later transfers run free. */
    let hold = true
    let started = 0
    let twoInFlight: () => void = () => undefined
    const both = new Promise<void>((resolve) => {
      twoInFlight = resolve
    })

    // A transfer the case holds open: the same signature the real one has, so
    // what is under test is the budget rather than a stub of the route
    const held = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }), {
      transfer: async (path, start, end, res) => {
        started += 1
        if (started === 2) twoInFlight()
        if (hold) await new Promise<void>((resolve) => releases.push(resolve))
        res.end(readFileSync(path).subarray(start, end + 1))
      }
    })
    await new Promise<void>((resolve) => held.listen(0, '127.0.0.1', resolve))
    const heldBase = `http://127.0.0.1:${(held.address() as AddressInfo).port}`
    const file = `${heldBase}/api/books/epub-1/file?format=epub`

    try {
      const first = fetch(file, { headers: auth })
      const second = fetch(file, { headers: auth })
      await both

      // **The app's own work is not behind this budget.** While two transfers
      // are stalled, the library route answers from the cache and the library
      // query itself runs — which is what the cap exists to guarantee (D9).
      expect((await fetch(`${heldBase}/api/library`, { headers: auth })).status).toBe(200)
      expect(db.getBooks().map((b) => b.id)).toContain('epub-1')

      const third = await fetch(file, { headers: auth })
      expect(third.status).toBe(503)
      expect(third.headers.get('retry-after')).toBe('1')
      expect(await third.json()).toEqual({ error: 'busy' })
      // The overflow was refused *before* a read: no threadpool slot, no `stat`
      expect(started).toBe(2)

      // Release the two the case is holding, and stop holding: what is being
      // decided is the budget, not this fake's willingness to ever finish
      hold = false
      releases.forEach((release) => release())

      for (const settled of [await first, await second]) {
        expect(settled.status).toBe(200)
        expect(sha256(Buffer.from(await settled.arrayBuffer()))).toBe(sha256(BOOK_BYTES))
      }

      // And the slot came back: a transfer that ends frees the budget
      const after = await fetch(file, { headers: auth })
      expect(after.status).toBe(200)
      expect(sha256(Buffer.from(await after.arrayBuffer()))).toBe(sha256(BOOK_BYTES))
    } finally {
      releases.forEach((release) => release())
      await new Promise<void>((resolve) => held.close(() => resolve()))
    }
  })

  it('gives the slot back when a transfer fails, so a broken read cannot spend the cap (AC17)', async () => {
    // The failure half of the budget. The `finally` in `sendBytes` is what returns the
    // slot when a read throws — a share that went away mid-transfer. Without it the cap is
    // spent for the process's life and every later byte request is a 503, with the suite
    // green, because the only other case observes `release` on a *successful* transfer.
    let calls = 0
    const releases: (() => void)[] = []
    let holding: () => void = () => undefined
    const started = new Promise<void>((resolve) => (holding = resolve))

    const broken = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }), {
      transfer: async (path, start, end, res) => {
        calls += 1
        if (calls === 1) throw new Error('the share went away')
        if (calls === 2) {
          holding()
          await new Promise<void>((resolve) => releases.push(resolve))
        }
        res.end(readFileSync(path).subarray(start, end + 1))
      }
    })
    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve))
    const brokenBase = `http://127.0.0.1:${(broken.address() as AddressInfo).port}`
    const file = `${brokenBase}/api/books/epub-1/file?format=epub`

    try {
      // Headers were decided before the read threw, so the client sees either the 200 with
      // a body that dies or a reset — the documented "connection closed after the status
      // has been sent" (invariant 12). Either way the request must not hang.
      const failed = await fetch(file, { headers: auth }).catch(() => null)
      if (failed) await expect(failed.arrayBuffer()).rejects.toThrow()

      // The second holds the *other* slot, so the budget is now fully spent. A third
      // request only gets a slot if the failed transfer returned its own.
      const held = fetch(file, { headers: auth })
      await started

      const third = await fetch(file, { headers: auth })
      expect(third.status).toBe(200)
      expect(sha256(Buffer.from(await third.arrayBuffer()))).toBe(sha256(BOOK_BYTES))

      releases.forEach((release) => release())
      expect((await held).status).toBe(200)
    } finally {
      releases.forEach((release) => release())
      await new Promise<void>((resolve) => broken.close(() => resolve()))
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/books/{id}/file?format=reflow (PDF-reflow slice 4, D8)
// ---------------------------------------------------------------------------

describe('the reflow route', () => {
  let server: Server
  let base: string
  let root: string
  let reflowEpub: string

  const EPUB_BYTES = Buffer.alloc(2048)
  for (let i = 0; i < EPUB_BYTES.length; i++) EPUB_BYTES[i] = (i * 5 + 3) % 249

  const produced = (): ReflowResult => ({
    status: 'produced',
    reason: '',
    verdict: 'ok',
    epub: 'derived/reflow.epub',
    stampFile: 'derived/reflow.json',
    pages: 3,
    bytes: EPUB_BYTES.length,
    seconds: 1
  })

  beforeEach(async () => {
    vi.mocked(reflow.ensure).mockReset()
    vi.mocked(reflow.wireStatus).mockReset().mockReturnValue(null)
    vi.mocked(reflow.recentRefusal).mockReset().mockReturnValue(null)

    root = mkdtempSync(join(tmpdir(), 'musaeum-rest-reflow-'))
    await nas.setLibraryRoot(root)
    vi.mocked(nas.isOnline).mockReturnValue(true)

    const dir = join(root, 'books', 'b1', 'derived')
    mkdirSync(dir, { recursive: true })
    reflowEpub = join(dir, 'reflow.epub')
    writeFileSync(reflowEpub, EPUB_BYTES)
    db.insertBook({ ...makeBook('b1'), formats: ['pdf'] })
    db.insertBook({ ...makeBook('has-epub'), formats: ['epub', 'pdf'] })

    server = createRestApiServer(config({ port: 0, bind: '127.0.0.1' }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    vi.useRealTimers()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  function get(path: string, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers } })
  }
  const URL_REFLOW = '/api/books/b1/file?format=reflow'

  it('404s a book that holds an EPUB, an unknown book, and never calls the pass', async () => {
    expect((await get('/api/books/has-epub/file?format=reflow')).status).toBe(404)
    expect((await get('/api/books/nope/file?format=reflow')).status).toBe(404)
    expect(reflow.ensure).not.toHaveBeenCalled()
  })

  it('503s with Retry-After 5 when the share is offline, before any pass', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(false)
    const res = await get(URL_REFLOW)
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '5'])
    expect(reflow.ensure).not.toHaveBeenCalled()
  })

  it("202s with the pass's progress while one is running, and starts nothing", async () => {
    vi.mocked(reflow.wireStatus).mockReturnValue({ phase: 'page', completed: 12, total: 24 })
    const res = await get(URL_REFLOW)
    expect([res.status, res.headers.get('retry-after')]).toEqual([202, '2'])
    expect(await res.json()).toEqual({ phase: 'page', completed: 12, total: 24 })
    expect(reflow.ensure).not.toHaveBeenCalled()
  })

  it('422s a remembered refusal without a new pass', async () => {
    vi.mocked(reflow.recentRefusal).mockReturnValue('no page carries a text layer')
    const res = await get(URL_REFLOW)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'cannot reflow',
      reason: 'no page carries a text layer'
    })
    expect(reflow.ensure).not.toHaveBeenCalled()
  })

  it('200s the artifact when the pass finishes inside the grace, with ETag and Range', async () => {
    vi.mocked(reflow.ensure).mockResolvedValue(produced())
    const res = await get(URL_REFLOW)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/epub+zip')
    expect(res.headers.get('etag')).toMatch(/^"\d+-\d+"$/)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(EPUB_BYTES)
    const ranged = await get(URL_REFLOW, { range: 'bytes=4-' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('etag')).toBe(res.headers.get('etag'))
  })

  it('404s a finished pass whose artifact is gone', async () => {
    vi.mocked(reflow.ensure).mockResolvedValue({ ...produced(), status: 'cached' })
    rmSync(reflowEpub)
    expect((await get(URL_REFLOW)).status).toBe(404)
  })

  it('202s when the pass outlives the grace, and a later settle is harmless', async () => {
    let fail!: (e: Error) => void
    let entered!: () => void
    const called = new Promise<void>((r) => (entered = r))
    vi.mocked(reflow.ensure).mockImplementation(() => {
      entered()
      return new Promise<ReflowResult>((_resolve, reject) => {
        fail = reject
      })
    })
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): number => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = get(URL_REFLOW)
      await called
      await vi.advanceTimersByTimeAsync(REFLOW_GRACE_MS + 1)
      const res = await pending
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ phase: 'start', completed: 0, total: 0 })
      fail(new Error('late failure'))
      await new Promise((r) => setImmediate(r))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('clears the grace timer when the pass wins', async () => {
    vi.mocked(reflow.ensure).mockResolvedValue(produced())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const before = vi.getTimerCount()
    const res = await get(URL_REFLOW)
    await res.arrayBuffer()
    expect(res.status).toBe(200)
    expect(vi.getTimerCount()).toBe(before)
  })

  it('422s a fallback result and a pre-flight rejection, 500s neither', async () => {
    vi.mocked(reflow.ensure).mockResolvedValue({
      ...produced(),
      status: 'fallback',
      reason: 'unreadable'
    })
    const fb = await get(URL_REFLOW)
    expect(fb.status).toBe(422)
    expect(await fb.json()).toEqual({ error: 'cannot reflow', reason: 'unreadable' })
    vi.mocked(reflow.ensure).mockRejectedValue(new Error('The metadata engine is unavailable'))
    const res = await get(URL_REFLOW)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { reason: string }).reason).toContain('unavailable')
  })

  it('holds no byte-gate slot for a 202', async () => {
    vi.mocked(reflow.wireStatus).mockReturnValue({ phase: 'page', completed: 1, total: 2 })
    for (let i = 0; i < 5; i++) expect((await get(URL_REFLOW)).status).toBe(202)
    vi.mocked(reflow.wireStatus).mockReturnValue(null)
    vi.mocked(reflow.ensure).mockResolvedValue(produced())
    expect((await get(URL_REFLOW)).status).toBe(200)
  })

  it('resolveBookFile still refuses reflow, so the wire opens only here', async () => {
    expect(await resolveBookFile('b1', 'reflow')).toBeNull()
  })
})
