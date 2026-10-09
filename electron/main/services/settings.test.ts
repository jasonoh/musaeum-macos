import { existsSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CONFIG_KEYS, AI_ENV_KEYS, DEFAULT_AI_BASE_URL } from './ai'
import { closeDb, getConfig, getDb, setConfig } from './db'
import {
  DEFAULT_REST_API_PORT,
  REST_API_CONFIG_KEYS,
  REST_API_STATES_AGREE,
  getRestApiView,
  getSettings,
  saveSettings,
  saveSettingsAndApply
} from './settings'
import * as sidecar from './sidecar'
import { LIBRARY_KIND_KEY } from './storage-kind'

// The real detection logic is kept (it's what these tests are about); only the
// relaunch is stubbed, so a save never spawns a Python process here
vi.mock('./sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sidecar')>()
  return { ...actual, restart: vi.fn(() => true) }
})

/**
 * The socket's own module, stubbed — and no case in this file opens one.
 *
 * These cases decide the *decision* the row depends on: when a save has to move
 * the listener, and when it must leave it alone. A real `node:http` bind is what
 * `api/rest.test.ts` decides, over a real socket on an ephemeral port; the one
 * thing this suite must never do is activate the server for real, because that
 * is a listen on whatever address this machine resolves — here, its tailnet one.
 *
 * The stub is a *recorder* rather than a model of the socket: it appends what it
 * was asked to do and answers with the status the case set, so the assertions
 * are about the order of the calls and nothing else.
 */
const socket = vi.hoisted(() => ({
  order: [] as string[],
  status: {
    state: 'disabled',
    address: null,
    port: null,
    reason: null,
    at: null
  } as {
    state: 'disabled' | 'starting' | 'listening' | 'failed'
    address: string | null
    port: number | null
    reason: string | null
    at: string | null
  }
}))

vi.mock('../api/rest', () => ({
  getRestApiStatus: () => ({ ...socket.status }),
  startRestApiIfEnabled: async () => {
    socket.order.push('start')
    return { ...socket.status }
  },
  stopRestApi: async () => {
    socket.order.push('stop')
    return { ...socket.status }
  }
}))

/** The venv interpreter the sidecar prefers — a real, valid Python path. */
const VENV_PYTHON = join(process.cwd(), 'sidecar', '.venv', 'bin', 'python')
const hasVenv = existsSync(VENV_PYTHON)

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  vi.mocked(sidecar.restart).mockClear()
  // Each case starts with nothing of ours on the wire
  socket.order.length = 0
  socket.status = { state: 'disabled', address: null, port: null, reason: null, at: null }
})

describe('getSettings', () => {
  it('reports an unset SMB URL as unset, with nothing compiled in (D5)', () => {
    const { values, resolved } = getSettings()
    expect(values.smbUrl).toBeNull()
    // Until slice 2 this resolved to the owner's own server as `source: 'default'`,
    // which put a stranger's hostname in the row of every user who never set one
    expect(resolved.smbUrl).toMatchObject({ value: null, source: 'none' })
  })

  it('reports a configured value as configured', () => {
    setConfig('smb_url', 'smb://elsewhere')
    const { values, resolved } = getSettings()
    expect(values.smbUrl).toBe('smb://elsewhere')
    expect(resolved.smbUrl).toMatchObject({ value: 'smb://elsewhere', source: 'configured' })
  })

  it.runIf(hasVenv)('falls back to the venv interpreter, marked auto', () => {
    const { values, resolved } = getSettings()
    expect(values.pythonPath).toBeNull()
    expect(resolved.pythonPath).toMatchObject({ value: VENV_PYTHON, source: 'auto' })
    expect(resolved.pythonPath.detail).toMatch(/^Python 3\./)
  })

  it('never echoes the API key back in the resolved view', () => {
    setConfig('google_books_api_key', 'AIzaSyEXAMPLEKEY123456')
    const { values, resolved } = getSettings()
    // The editable value is the user's own; the resolved one is masked
    expect(values.googleBooksApiKey).toBe('AIzaSyEXAMPLEKEY123456')
    expect(resolved.googleBooksApiKey.value).toBeNull()
    expect(resolved.googleBooksApiKey.source).toBe('configured')
    expect(resolved.googleBooksApiKey.detail).toBe('AIza••••3456')
    expect(resolved.googleBooksApiKey.detail).not.toContain('EXAMPLEKEY')
  })

  it('says the app will not mount a share on its own, and names no hostname (D5)', () => {
    // The note an unset field gets, now that nothing is in force behind it. What
    // it replaces described a machine the user does not own.
    const note = getSettings().resolved.smbUrl.detail
    expect(note).toMatch(/will not mount one for you/)
    expect(note).not.toMatch(/nas|smb:/i)
  })

  it('names the cloud client a synced library folder sits inside (D7)', () => {
    setConfig(
      'library_root',
      join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Musaeum')
    )
    const note = getSettings().syncRootNote
    expect(note).toContain('iCloud Drive')
    expect(note).toMatch(/remove a file’s contents/)
  })

  it('names the client for a conventional Dropbox path too', () => {
    setConfig('library_root', join(homedir(), 'Dropbox/Books'))
    expect(getSettings().syncRootNote).toContain('Dropbox')
  })

  it('says nothing about syncing for a library on the boot disk', () => {
    setConfig('library_root', join(homedir(), 'Documents/Musaeum'))
    expect(getSettings().syncRootNote).toBeNull()
  })

  it('says nothing about syncing when no folder is chosen at all', () => {
    expect(getSettings().syncRootNote).toBeNull()
  })

  it('reports the kind in the words the row shows, not the union member', () => {
    setConfig('library_root', join(homedir(), 'Documents/Musaeum'))
    setConfig(LIBRARY_KIND_KEY, 'local')
    const { value, source, detail } = getSettings().resolved.libraryKind
    expect(value).toBe('Local folder')
    expect(source).toBe('auto')
    expect(detail).toBe('Resolved from the folder when it was chosen')
  })
})

describe('saveSettings', () => {
  it('writes a valid value', () => {
    saveSettings({ smbUrl: 'smb://nas.local' })
    expect(getConfig('smb_url')).toBe('smb://nas.local')
  })

  it('clears a key when the field is blank, restoring auto-detection', () => {
    setConfig('smb_url', 'smb://nas.local')
    saveSettings({ smbUrl: '' })
    // Deleted, not stored as '' — every reader treats missing as "nothing named"
    expect(getConfig('smb_url')).toBeNull()
    expect(getSettings().resolved.smbUrl.source).toBe('none')
  })

  it('leaves fields that were not submitted alone', () => {
    setConfig('smb_url', 'smb://nas.local')
    saveSettings({ googleBooksApiKey: 'key-1' })
    expect(getConfig('smb_url')).toBe('smb://nas.local')
  })

  it.each([
    ['smbUrl', 'nas', /Not an SMB URL/],
    ['smbUrl', 'http://nas', /Not an SMB URL/],
    ['pythonPath', '/nope/python', /No Python interpreter at/],
    ['pythonPath', tmpdir(), /Not a file/]
  ])('rejects %s = %s', (field, value, message) => {
    expect(() => saveSettings({ [field]: value })).toThrow(message)
  })

  it('rejects an executable that is not a Python interpreter', () => {
    // Electron's own binary exists and runs, but reports no Python version
    expect(() => saveSettings({ pythonPath: process.execPath })).toThrow(
      /Could not read a version|did not run/
    )
  })

  it('writes nothing when any field in the batch fails validation', () => {
    expect(() => saveSettings({ smbUrl: 'smb://good', pythonPath: '/nope/python' })).toThrow()
    expect(getConfig('smb_url')).toBeNull()
  })

  it.runIf(hasVenv)('accepts a real interpreter and restarts the sidecar', () => {
    saveSettings({ pythonPath: VENV_PYTHON })
    expect(getConfig('python_path')).toBe(VENV_PYTHON)
    expect(sidecar.restart).toHaveBeenCalledTimes(1)
  })

  it('restarts the sidecar when the API key changes', () => {
    saveSettings({ googleBooksApiKey: 'key-1' })
    expect(sidecar.restart).toHaveBeenCalledTimes(1)
  })

  it('does not restart the sidecar on a no-op re-save', () => {
    setConfig('google_books_api_key', 'key-1')
    saveSettings({ googleBooksApiKey: 'key-1' })
    expect(sidecar.restart).not.toHaveBeenCalled()
  })

  it('does not restart the sidecar for settings it never reads', () => {
    saveSettings({ smbUrl: 'smb://nas.local' })
    expect(sidecar.restart).not.toHaveBeenCalled()
  })
})

/**
 * The ask panel's three fields.
 *
 * They are the first settings in this app that are *not* a path and not a
 * sidecar input: read per question, never at spawn time, so the restart rule
 * that governs the interpreter and the Google Books key must not reach them.
 */
describe('the ask panel settings', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults the endpoint to a local model, and says it is local', () => {
    const { values, resolved } = getSettings()
    expect(values.aiBaseUrl).toBeNull()
    expect(resolved.aiBaseUrl).toMatchObject({ value: DEFAULT_AI_BASE_URL, source: 'default' })
    expect(resolved.aiBaseUrl.detail).toContain('nothing leaves this machine')
  })

  it('reports an unset model as unavailable rather than inventing one', () => {
    const { values, resolved } = getSettings()
    expect(values.aiModel).toBeNull()
    expect(resolved.aiModel).toMatchObject({ value: null, source: 'none' })
    expect(resolved.aiModel.detail).toMatch(/Unset/)
  })

  it('says plainly when a remote endpoint is the one receiving the payload', () => {
    setConfig(AI_CONFIG_KEYS.baseUrl, 'https://api.example.com/v1')
    setConfig(AI_CONFIG_KEYS.model, 'gpt-x')
    const { resolved } = getSettings()
    expect(resolved.aiBaseUrl.source).toBe('configured')
    expect(resolved.aiBaseUrl.detail).toContain('api.example.com receives what you send')
  })

  it('never echoes the AI key back in the resolved view', () => {
    setConfig(AI_CONFIG_KEYS.apiKey, 'sk-EXAMPLEKEY123456')
    const { values, resolved } = getSettings()
    expect(values.aiApiKey).toBe('sk-EXAMPLEKEY123456')
    expect(resolved.aiApiKey.value).toBeNull()
    expect(resolved.aiApiKey.source).toBe('configured')
    expect(resolved.aiApiKey.detail).toBe('sk-E••••3456')
    expect(resolved.aiApiKey.detail).not.toContain('EXAMPLEKEY')
  })

  it('inherits the AI key from the environment, marked env', () => {
    vi.stubEnv(AI_ENV_KEYS.apiKey, 'sk-from-environment-1234')
    const { resolved } = getSettings()
    expect(resolved.aiApiKey.source).toBe('env')
    expect(resolved.aiApiKey.detail).toBe('sk-f••••1234')
  })

  it('rejects an endpoint that is not an http(s) URL, writing nothing', () => {
    expect(() => saveSettings({ aiBaseUrl: 'localhost:11434' })).toThrow(/Not an endpoint URL/)
    expect(getConfig(AI_CONFIG_KEYS.baseUrl)).toBeNull()
  })

  it('writes and clears the AI fields without restarting the sidecar', () => {
    saveSettings({ aiBaseUrl: 'http://127.0.0.1:1234/v1', aiModel: 'llama3.2' })
    expect(getConfig(AI_CONFIG_KEYS.baseUrl)).toBe('http://127.0.0.1:1234/v1')
    expect(getConfig(AI_CONFIG_KEYS.model)).toBe('llama3.2')
    // Read per request: changing the endpoint must never bounce a hydration
    expect(sidecar.restart).not.toHaveBeenCalled()

    saveSettings({ aiModel: '' })
    expect(getConfig(AI_CONFIG_KEYS.model)).toBeNull()
    expect(getSettings().resolved.aiModel.source).toBe('none')
  })

  it('keeps the trailing-slash-free endpoint it validated', () => {
    saveSettings({ aiBaseUrl: 'http://127.0.0.1:11434/v1/' })
    expect(getConfig(AI_CONFIG_KEYS.baseUrl)).toBe('http://127.0.0.1:11434/v1/')
    // Stored as typed; normalized on read, so the client never builds `/v1//chat`
    expect(getSettings().resolved.aiBaseUrl.value).toBe('http://127.0.0.1:11434/v1')
  })
})

/**
 * The phone API, as the Settings row saves it and reads it (slice 2, AC27–28).
 *
 * The dialog's entry point is `saveSettingsAndApply` and its read path is
 * `getRestApiView`; both are decided here over the stubbed socket above, so the
 * cases are about the *row's* contract — what a save writes, when the listener
 * has to move, and what the row is handed — rather than about `node:http`.
 * Which address a phone can actually reach, and whether a bind is refused, is
 * `api/rest.test.ts`'s and slice 2's probe's business.
 */
describe('the phone API settings', () => {
  const PORT = '8798'
  const BIND = '127.0.0.1'

  /** The socket up and holding the values the four keys resolve to. */
  const listening = (): void => {
    setConfig(REST_API_CONFIG_KEYS.enabled, 'true')
    setConfig(REST_API_CONFIG_KEYS.port, PORT)
    setConfig(REST_API_CONFIG_KEYS.bind, BIND)
    socket.status = {
      state: 'listening',
      address: BIND,
      port: Number(PORT),
      reason: null,
      at: null
    }
  }

  it('writes the four keys and answers with the view the dialog should show (AC28)', async () => {
    // The key *set* is what decides "exactly the four keys and nothing else": four
    // reads by name cannot notice a fifth key being written alongside them.
    const keySet = () =>
      new Set(
        (getDb().prepare('SELECT key FROM app_config').all() as { key: string }[]).map(
          (row) => row.key
        )
      )
    const keysBefore = keySet()

    const view = await saveSettingsAndApply({
      restApiEnabled: 'true',
      restApiPort: PORT,
      restApiBind: BIND
    })

    expect(getConfig(REST_API_CONFIG_KEYS.enabled)).toBe('true')
    expect(getConfig(REST_API_CONFIG_KEYS.port)).toBe(PORT)
    expect(getConfig(REST_API_CONFIG_KEYS.bind)).toBe(BIND)
    // Generated on enable and never typed (D13): 32 random bytes, hex
    expect(getConfig(REST_API_CONFIG_KEYS.token)).toMatch(/^[0-9a-f]{64}$/)
    // The reply is composed *after* the write, so the dialog cannot re-render
    // from a value older than its own save
    expect(view.values.restApiEnabled).toBe('true')
    expect(view.values.restApiPort).toBe(PORT)
    expect(view.values.restApiToken).toBe(getConfig(REST_API_CONFIG_KEYS.token))

    const expected = new Set([
      ...keysBefore,
      REST_API_CONFIG_KEYS.enabled,
      REST_API_CONFIG_KEYS.port,
      REST_API_CONFIG_KEYS.bind,
      REST_API_CONFIG_KEYS.token
    ])
    expect([...keySet()].sort()).toEqual([...expected].sort())
  })

  it('starts the socket from off, and stops it again', async () => {
    // Enabling generates the token, and the token is one of the values the
    // socket captures — so the first enable takes the same path as any other
    // move: stop (a settled no-op while nothing of ours is on the wire), start.
    await saveSettingsAndApply({ restApiEnabled: 'true' })
    expect(socket.order).toEqual(['stop', 'start'])
    await saveSettingsAndApply({ restApiEnabled: 'false' })
    expect(socket.order).toEqual(['stop', 'start', 'stop'])
    // The credential survives disabling, so re-enabling hands the same one back
    expect(getConfig(REST_API_CONFIG_KEYS.token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the token a later save finds, and generates one only on enable', async () => {
    await saveSettingsAndApply({ restApiEnabled: 'true' })
    const token = getConfig(REST_API_CONFIG_KEYS.token)

    await saveSettingsAndApply({ restApiEnabled: 'true' })
    expect(getConfig(REST_API_CONFIG_KEYS.token)).toBe(token)

    // A save that does not touch the flag never touches the credential — which
    // is why the row's switch sends no `restApiToken` at all: a blank one would
    // clear the token the phone is configured with.
    await saveSettingsAndApply({ restApiPort: '8799' })
    expect(getConfig(REST_API_CONFIG_KEYS.token)).toBe(token)
  })

  it('restarts a listening socket when a key it captured at creation moves', async () => {
    // The server captures the token, the port and the bind by closure when it is
    // created, so a save that changes one leaves a live socket serving the old
    // values — the pre-merge review's finding, and this slice's own work.
    listening()
    await saveSettingsAndApply({ restApiPort: '8799' })
    expect(socket.order).toEqual(['stop', 'start'])
  })

  it('leaves a listening socket alone for a save that moved nothing it captured', async () => {
    // The `sidecarAffected` rule one layer over: a re-save — of an unrelated
    // field, or of nothing at all — must not bounce the listener out from under
    // a download in flight.
    listening()
    await saveSettingsAndApply({ smbUrl: 'smb://nas.local' })
    expect(socket.order).toEqual([])
  })

  it('retries a listen that failed, because a save is the retry the owner has', async () => {
    listening()
    socket.status = {
      state: 'failed',
      address: BIND,
      port: Number(PORT),
      reason: `port ${PORT} is already in use on ${BIND} (EADDRINUSE)`,
      at: null
    }
    await saveSettingsAndApply({ smbUrl: 'smb://nas.local' })
    expect(socket.order).toEqual(['stop', 'start'])
  })

  it('rejects a bad port or bind without writing, and without moving the listener', async () => {
    listening()
    await expect(saveSettingsAndApply({ restApiPort: 'eighty' })).rejects.toThrow(/Not a port/)
    await expect(saveSettingsAndApply({ restApiBind: '0.0.0.0' })).rejects.toThrow(
      /Not a bind address/
    )
    expect(getConfig(REST_API_CONFIG_KEYS.port)).toBe(PORT)
    expect(getConfig(REST_API_CONFIG_KEYS.bind)).toBe(BIND)
    expect(socket.order).toEqual([])
  })

  it('deletes the port and the bind when they are cleared, so both go back to auto', async () => {
    setConfig(REST_API_CONFIG_KEYS.port, PORT)
    setConfig(REST_API_CONFIG_KEYS.bind, BIND)

    await saveSettingsAndApply({ restApiPort: '', restApiBind: '' })

    expect(getConfig(REST_API_CONFIG_KEYS.port)).toBeNull()
    expect(getConfig(REST_API_CONFIG_KEYS.bind)).toBeNull()
    // Nothing is left naming an address, so the resolver is free to choose the
    // tailnet one again. Asserted as "not an override" rather than by naming the
    // address: this machine's interfaces are not a fixture (`api/bind.test.ts`
    // decides the resolver over stub maps), and a case that read them would only
    // pass on a machine that is on a tailnet.
    expect(getRestApiView().addressSource).not.toBe('override')
  })

  it('builds the phone’s URL from the address in force, bracketing an IPv6 literal', () => {
    setConfig(REST_API_CONFIG_KEYS.bind, '::1')
    expect(getRestApiView().url).toBe(`http://[::1]:${DEFAULT_REST_API_PORT}`)

    setConfig(REST_API_CONFIG_KEYS.bind, BIND)
    setConfig(REST_API_CONFIG_KEYS.port, PORT)
    const view = getRestApiView()
    expect(view.url).toBe(`http://${BIND}:${PORT}`)
    expect(view.addressSource).toBe('override')
  })

  it('carries the resolver’s refusal where the URL would have been', () => {
    // A hand-edited row: validation never stores this, which is exactly why the
    // read path has to answer for it — the rule `theme_tokens` follows.
    setConfig(REST_API_CONFIG_KEYS.bind, '0.0.0.0')
    const view = getRestApiView()
    expect(view.url).toBeNull()
    expect(view.address).toBeNull()
    expect(view.addressReason).toMatch(/neither loopback nor a tailnet address/)
  })

  it('hands the row the socket’s own report, unchanged (AC27)', () => {
    socket.status = {
      state: 'failed',
      address: BIND,
      port: Number(PORT),
      reason: `port ${PORT} is already in use on ${BIND} (EADDRINUSE)`,
      at: '2026-09-22T12:00:00.000Z'
    }
    expect(getRestApiView().status).toEqual(socket.status)
  })

  it('keeps the row’s state union and the socket’s the same set of members (AC27)', () => {
    // The decider is `npm run typecheck`: `REST_API_STATES_AGREE` is typed so a
    // member added or removed on either side fails to compile. This case is here
    // so the claim has a name in the suite, and so the two source texts have to
    // agree as well as the types — the renderer cannot import the socket's union
    // across the bridge, so it is restated, and a restatement is what drifts.
    expect(REST_API_STATES_AGREE).toBe(true)

    const says = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')
    const members = (source: string, name: string): string =>
      (source.match(new RegExp(`${name}\\s*=\\s*([^\\n]+)`))?.[1] ?? '').replace(/[\s']/g, '')

    expect(members(says('src/types/settings.types.ts'), 'RestApiListenState')).toBe(
      members(says('electron/main/api/rest.ts'), 'RestApiState')
    )
  })
})
