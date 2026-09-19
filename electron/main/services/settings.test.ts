import { existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_CONFIG_KEYS, AI_ENV_KEYS, DEFAULT_AI_BASE_URL } from './ai'
import { closeDb, getConfig, setConfig } from './db'
import { DEFAULT_SMB_URL, getSettings, saveSettings } from './settings'
import * as sidecar from './sidecar'

// The real detection logic is kept (it's what these tests are about); only the
// relaunch is stubbed, so a save never spawns a Python process here
vi.mock('./sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sidecar')>()
  return { ...actual, restart: vi.fn(() => true) }
})

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
})

describe('getSettings', () => {
  it('reports the compiled-in SMB default when nothing is configured', () => {
    const { values, resolved } = getSettings()
    expect(values.smbUrl).toBeNull()
    expect(resolved.smbUrl).toMatchObject({ value: DEFAULT_SMB_URL, source: 'default' })
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
})

describe('saveSettings', () => {
  it('writes a valid value', () => {
    saveSettings({ smbUrl: 'smb://ohnas.local' })
    expect(getConfig('smb_url')).toBe('smb://ohnas.local')
  })

  it('clears a key when the field is blank, restoring auto-detection', () => {
    setConfig('smb_url', 'smb://ohnas.local')
    saveSettings({ smbUrl: '' })
    // Deleted, not stored as '' — every reader treats missing as "use default"
    expect(getConfig('smb_url')).toBeNull()
    expect(getSettings().resolved.smbUrl.source).toBe('default')
  })

  it('leaves fields that were not submitted alone', () => {
    setConfig('smb_url', 'smb://ohnas.local')
    saveSettings({ googleBooksApiKey: 'key-1' })
    expect(getConfig('smb_url')).toBe('smb://ohnas.local')
  })

  it.each([
    ['smbUrl', 'ohnas', /Not an SMB URL/],
    ['smbUrl', 'http://ohnas', /Not an SMB URL/],
    ['pythonPath', '/nope/python', /No Python interpreter at/],
    ['pythonPath', tmpdir(), /Not a file/],
    ['ebookConvertPath', '/nope/ebook-convert', /No ebook-convert at/]
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
    saveSettings({ smbUrl: 'smb://ohnas.local', ebookConvertPath: '' })
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
