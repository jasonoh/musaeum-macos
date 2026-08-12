import { existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
