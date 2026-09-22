import { rmSync } from 'fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeBook } from '../../../test/helpers/book'
import { type InterfaceMap } from '../services/api/bind'
import * as db from '../services/db'
import * as nas from '../services/nas-manager'
import {
  DEFAULT_REST_API_PORT,
  REST_API_CONFIG_KEYS,
  getSettings,
  resolveRestApiConfig,
  saveSettings,
  type ResolvedRestApiConfig
} from '../services/settings'
import {
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
  // The only way to reach `library: 'online'` without a mounted share
  return { ...actual, isOnline: vi.fn(() => false) }
})

vi.mock('../services/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/db')>()
  // A wrapper, not a stub: the real query still answers, and one case can make
  // it throw to prove a failed handler answers 500 instead of dying
  return { ...actual, getBooks: vi.fn(actual.getBooks) }
})

const TOKEN = 'a1b2c3d4'.repeat(8)
const WRONG = 'deadbeef'.repeat(8)

/** The machine as measured 2026-09-22, as a fixture — never this machine's map. */
const MEASURED: InterfaceMap = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  en0: [{ address: '192.168.1.103', family: 'IPv4', internal: false }],
  utun9: [{ address: '100.125.135.108', family: 'IPv4', internal: false }],
  utun8: [{ address: '10.2.0.2', family: 'IPv4', internal: false }]
}

function config(overrides: Partial<ResolvedRestApiConfig> = {}): ResolvedRestApiConfig {
  return { enabled: true, port: DEFAULT_REST_API_PORT, bind: '', token: TOKEN, ...overrides }
}

/** A listen that answers without a socket, so "was it attempted?" is decidable. */
function recordingListen(
  outcome: ListenOutcome = { ok: true, address: '100.125.135.108', port: DEFAULT_REST_API_PORT }
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
    saveSettings({ restApiPort: '9000', restApiBind: '100.125.135.108' })
    expect(db.getConfig(REST_API_CONFIG_KEYS.port)).toBe('9000')
    expect(db.getConfig(REST_API_CONFIG_KEYS.bind)).toBe('100.125.135.108')

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
    ['restApiBind', '192.168.1.103', /Not a bind address/],
    ['restApiBind', '10.2.0.2', /Not a bind address/],
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
      address: '100.125.135.108',
      port: DEFAULT_REST_API_PORT,
      reason: null,
      at: expect.any(String)
    })
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen.mock.calls[0].slice(1)).toEqual(['100.125.135.108', DEFAULT_REST_API_PORT])
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
      config: config({ bind: '192.168.1.103' }),
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
      interfaces: { utun8: [{ address: '10.2.0.2', family: 'IPv4', internal: false }] },
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
    // The 401 path reaches no route: the health route's query never ran, so an
    // unauthenticated request cannot even learn that the route exists
    expect(vi.mocked(db.getBooks)).not.toHaveBeenCalled()
  })

  it('answers 401 for a wrong token and for a malformed one (AC2)', async () => {
    const wrong = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${WRONG}` }
    })
    const malformed = await fetch(`${base}/api/health`, { headers: { authorization: 'Basic x' } })

    expect(wrong.status).toBe(401)
    expect(malformed.status).toBe(401)
    expect(vi.mocked(db.getBooks)).not.toHaveBeenCalled()
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
  })

  it('reports the library online exactly when the share is mounted', async () => {
    vi.mocked(nas.isOnline).mockReturnValue(true)
    const res = await fetch(`${base}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(await res.json()).toMatchObject({ library: 'online' })
  })

  it('answers 404 for an unmatched path, and 401 for one with no token', async () => {
    const unknown = await fetch(`${base}/api/library`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ error: 'not found' })

    // Auth runs first, so an unknown path is not distinguished from a known one
    expect((await fetch(`${base}/api/library`)).status).toBe(401)
  })

  it('answers 500 when a route throws, and keeps serving (invariant 12)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.mocked(db.getBooks).mockImplementationOnce(() => {
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
