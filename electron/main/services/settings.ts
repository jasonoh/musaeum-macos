import { spawnSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import type { AppSettings, EditableSettings, SettingsView } from '@shared/settings.types'
import * as ai from './ai'
import { deleteConfig, getConfig, setConfig } from './db'
import { getLibraryRoot } from './nas-manager'
// The version rules live with the module that builds the venv, so validating
// a hand-picked interpreter and choosing one automatically can't disagree
import { MIN_PYTHON, meetsMinimum, parseVersion } from './python-env'
import * as sidecar from './sidecar'

/**
 * The Settings surface over `app_config`.
 *
 * Two things this file is careful about:
 *
 * 1. It never re-implements detection. What python or ebook-convert resolve to
 *    is asked of `sidecar.ts`, which is what actually runs them — otherwise
 *    Settings could confidently report a path the app doesn't use.
 * 2. A bad path is rejected at save time rather than stored and discovered
 *    later as a failed conversion or a dead sidecar. Clearing a field is
 *    always allowed: it means "go back to auto-detection".
 */

export const DEFAULT_SMB_URL = 'smb://ohnas'

const CONFIG_KEYS: Record<keyof EditableSettings, string> = {
  smbUrl: 'smb_url',
  // The ask panel's endpoint, model and key. Not in SIDECAR_KEYS below: they are
  // read per request, so changing one must not bounce the Python process out
  // from under a hydration that is in flight.
  aiBaseUrl: ai.AI_CONFIG_KEYS.baseUrl,
  aiModel: ai.AI_CONFIG_KEYS.model,
  aiApiKey: ai.AI_CONFIG_KEYS.apiKey,
  pythonPath: 'python_path',
  ebookConvertPath: 'ebook_convert_path',
  googleBooksApiKey: 'google_books_api_key'
}

/** Changing either of these only takes effect on a fresh sidecar spawn. */
const SIDECAR_KEYS: (keyof EditableSettings)[] = ['pythonPath', 'googleBooksApiKey']

export function getSettings(): SettingsView {
  const values: AppSettings = {
    libraryRoot: getLibraryRoot(),
    smbUrl: getConfig(CONFIG_KEYS.smbUrl),
    aiBaseUrl: getConfig(CONFIG_KEYS.aiBaseUrl),
    aiModel: getConfig(CONFIG_KEYS.aiModel),
    aiApiKey: getConfig(CONFIG_KEYS.aiApiKey),
    pythonPath: getConfig(CONFIG_KEYS.pythonPath),
    ebookConvertPath: getConfig(CONFIG_KEYS.ebookConvertPath),
    googleBooksApiKey: getConfig(CONFIG_KEYS.googleBooksApiKey)
  }

  const aiStatus = ai.getStatus()
  const aiKey = ai.resolveKey()
  const python = sidecar.resolvePython()
  const ebookConvert = sidecar.resolveEbookConvert()
  const googleKey = sidecar.resolveGoogleBooksKey()

  return {
    values,
    resolved: {
      smbUrl: values.smbUrl
        ? { value: values.smbUrl, source: 'configured' }
        : { value: DEFAULT_SMB_URL, source: 'default' },
      // The endpoint and the model already carry their own detail lines from the
      // one place that computes them, so Settings and the panel cannot disagree
      // about whether the payload stays on this machine.
      aiBaseUrl: aiStatus.endpoint,
      aiModel: aiStatus.model,
      // Never echoed back in `resolved`, the rule the Google Books key follows:
      // the configured value is the user's own and already rides in `values`, so
      // what is left to report is where the key in force came from.
      aiApiKey: {
        value: null,
        source: aiKey.value ? aiKey.source : 'none',
        detail: aiKey.value ? mask(aiKey.value) : 'Unset — a local model usually needs no key'
      },
      pythonPath: {
        value: python.path,
        source: python.source,
        detail:
          python.source === 'none'
            ? 'No interpreter found — metadata features are disabled'
            : describeVersion(python.path)
      },
      ebookConvertPath: {
        value: ebookConvert.path,
        source: ebookConvert.source,
        detail:
          ebookConvert.source === 'none'
            ? 'Calibre not found — format conversion is unavailable'
            : undefined
      },
      // Never echoed back in `resolved`: an env-provided key isn't the user's
      // to edit here, and the configured one already rides along in `values`
      googleBooksApiKey: {
        value: null,
        source: googleKey.source,
        detail: googleKey.key ? mask(googleKey.key) : 'Unset — Google Books runs unauthenticated'
      }
    }
  }
}

/**
 * Apply the fields present in `updates`. Absent fields are left alone; a field
 * present but blank is cleared back to auto-detection. Validates everything
 * before writing anything, so a rejected save changes nothing.
 */
export function saveSettings(updates: Partial<EditableSettings>): void {
  const entries = Object.entries(updates) as [keyof EditableSettings, string | null][]
  const normalized = entries.map(([field, raw]) => [field, (raw ?? '').trim()] as const)

  for (const [field, value] of normalized) {
    if (value) validate(field, value)
  }

  // Compared against the stored values so a no-op re-save doesn't bounce the
  // sidecar out from under a hydration that's in flight
  let sidecarAffected = false
  for (const [field, value] of normalized) {
    const key = CONFIG_KEYS[field]
    const before = getConfig(key) ?? ''
    if (value === before) continue
    if (value) setConfig(key, value)
    else deleteConfig(key)
    if (SIDECAR_KEYS.includes(field)) sidecarAffected = true
  }

  // The interpreter and the API key are both read at spawn time
  if (sidecarAffected) sidecar.restart()
}

function validate(field: keyof EditableSettings, value: string): void {
  switch (field) {
    case 'smbUrl':
      if (!/^smb:\/\/\S+$/.test(value)) {
        throw new Error(`Not an SMB URL: ${value} — expected something like ${DEFAULT_SMB_URL}`)
      }
      return
    case 'aiBaseUrl':
      if (!ai.isHttpUrl(value)) {
        throw new Error(
          `Not an endpoint URL: ${value} — expected something like ${ai.DEFAULT_AI_BASE_URL}`
        )
      }
      return
    case 'aiModel':
      // Presence is the whole requirement here. Whether the model actually
      // exists is the endpoint's answer to give, and a wrong name fails the
      // request with the server's own sentence rather than being rejected blind.
      return
    case 'aiApiKey':
      // Only a live request can tell a good key from a bad one — the same
      // reasoning the Google Books key already documents.
      return
    case 'pythonPath':
      assertExecutable(value, 'Python interpreter')
      assertPythonVersion(value)
      return
    case 'ebookConvertPath':
      assertExecutable(value, 'ebook-convert')
      return
    case 'googleBooksApiKey':
      // Only a live request could tell a good key from a bad one, and a
      // rejected key already degrades to unauthenticated fetches
      return
  }
}

function assertExecutable(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`No ${label} at ${path}`)
  if (!statSync(path).isFile()) throw new Error(`Not a file: ${path} — pick the ${label} itself`)
}

function assertPythonVersion(path: string): void {
  const res = spawnSync(path, ['--version'], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`${path} did not run — is it a Python interpreter?`)
  const version = parseVersion(`${res.stdout}${res.stderr}`)
  if (!version) throw new Error(`Could not read a version from ${path}`)
  if (!meetsMinimum(version)) {
    throw new Error(
      `Python ${version[0]}.${version[1]} is too old — the sidecar needs ${MIN_PYTHON[0]}.${MIN_PYTHON[1]} or newer`
    )
  }
}

/** Enough of a key to recognize, not enough to use. */
function mask(key: string): string {
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`
}

export function describeVersion(path: string | null): string | undefined {
  if (!path) return undefined
  const res = spawnSync(path, ['--version'], { encoding: 'utf8' })
  if (res.status !== 0) return undefined
  return `${res.stdout}${res.stderr}`.trim().split('\n')[0]
}
