import { spawnSync } from 'child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'fs'
import type { AppSettings, EditableSettings, SettingsView } from '@shared/settings.types'
import * as ai from './ai'
import { TAILNET_CIDR, isAllowedBindAddress } from './api/bind'
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

/**
 * `app_config` keys for the API surface, defined here so the raw strings have
 * exactly one home — the reason `AI_CONFIG_KEYS` lives in `ai.ts`. `enabled`
 * already existed for this consumer; the other three are slice 1a's.
 */
export const REST_API_CONFIG_KEYS = {
  enabled: 'rest_api_enabled',
  port: 'rest_api_port',
  token: 'rest_api_token',
  bind: 'rest_api_bind'
} as const

/**
 * The port the API listens on unless the owner sets another. Chosen by
 * measurement on 2026-09-22: 8787 is the Hermes WebUI on this machine and 9119
 * another listener, while 8788 was held by nothing (`lsof -nP -iTCP:8788`).
 */
export const DEFAULT_REST_API_PORT = 8788

/** The range `rest_api_port` may hold: unprivileged ports only. */
export const MIN_REST_API_PORT = 1024
export const MAX_REST_API_PORT = 65535

const CONFIG_KEYS: Record<keyof EditableSettings, string> = {
  smbUrl: 'smb_url',
  restApiEnabled: REST_API_CONFIG_KEYS.enabled,
  restApiPort: REST_API_CONFIG_KEYS.port,
  restApiToken: REST_API_CONFIG_KEYS.token,
  restApiBind: REST_API_CONFIG_KEYS.bind,
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
    // The API surface's four. The token is the user's own generated credential,
    // so it rides in `values` exactly as the Google Books key does — what never
    // rides anywhere is a *masked* one, which is why the server reads
    // `resolveRestApiConfig()` below instead of this view.
    restApiEnabled: getConfig(CONFIG_KEYS.restApiEnabled),
    restApiPort: getConfig(CONFIG_KEYS.restApiPort),
    restApiToken: getConfig(CONFIG_KEYS.restApiToken),
    restApiBind: getConfig(CONFIG_KEYS.restApiBind),
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

  // Enabling the API generates its credential **when there is none**, and only
  // then: a second enable — or a re-save while it is already on — must never
  // replace the token the phone has been configured with, and disabling does not
  // delete it, so re-enabling hands the same URL and credential back. A token
  // the user cleared is a token they asked to be gone, so the next enable makes
  // a fresh one.
  //
  // Written after the loop rather than in `validate`, deliberately: validation
  // runs before any write, and a save that is about to be rejected must leave no
  // token behind.
  const enabling = normalized.some(
    ([field, value]) => field === 'restApiEnabled' && value === 'true'
  )
  if (enabling && !getConfig(REST_API_CONFIG_KEYS.token)) {
    setConfig(REST_API_CONFIG_KEYS.token, generateRestApiToken())
  }

  // The interpreter and the API key are both read at spawn time
  if (sidecarAffected) sidecar.restart()
}

/**
 * A fresh credential: 32 random bytes, hex. Generated over a user-chosen
 * password because a token that is only ever used here cannot be a credential
 * reused from somewhere else (the OPDS spec's D8, adopted as written).
 */
function generateRestApiToken(): string {
  return randomBytes(32).toString('hex')
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
    case 'restApiEnabled':
      // `'true'`/`'false'` rather than a boolean because `app_config` is a
      // string table — and strict rather than case-insensitive so the one value
      // the server reads (`=== 'true'`) is the one value that can be stored.
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Not a flag: ${value} — expected 'true' or 'false'`)
      }
      return
    case 'restApiPort': {
      const port = /^\d+$/.test(value) ? Number(value) : NaN
      // Written as a positive range test on purpose: `port < MIN || port > MAX`
      // is false for NaN, so `'eighty'` would sail through a negative test
      if (!(port >= MIN_REST_API_PORT && port <= MAX_REST_API_PORT)) {
        throw new Error(
          `Not a port: ${value} — expected an integer from ${MIN_REST_API_PORT} to ${MAX_REST_API_PORT}`
        )
      }
      return
    }
    case 'restApiToken':
      // Never typed by hand (it is generated on enable), so this only has to
      // stop a value an HTTP header cannot carry — and it never echoes the
      // value back, only its length: a rejected credential is still a secret.
      if (!/^[!-~]{16,}$/.test(value)) {
        throw new Error(
          `Not a token: ${value.length} characters — a token is at least 16 printable characters with no spaces`
        )
      }
      return
    case 'restApiBind':
      // The same rule the server binds by, from the same function, so a value
      // that saves is a value that starts — and the refusal lands here, where
      // the user can read it, rather than at the next launch.
      if (!isAllowedBindAddress(value)) {
        throw new Error(
          `Not a bind address: ${value} — the API binds loopback or a tailnet address (${TAILNET_CIDR})`
        )
      }
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

// ---------------------------------------------------------------------------
// The API surface, resolved for the server
// ---------------------------------------------------------------------------

/** What `api/rest.ts` runs with: the four keys, resolved. */
export interface ResolvedRestApiConfig {
  /** `rest_api_enabled === 'true'` — absent or anything else means nothing listens. */
  enabled: boolean
  /** The port to bind, or the default when the key is unset or unusable. */
  port: number
  /** An address named in `rest_api_bind`, or `''` to resolve one from the interfaces. */
  bind: string
  /**
   * The credential in force, or null when there is none — in which case the
   * server refuses to start rather than serving without one.
   */
  token: string | null
}

/**
 * The values the API server runs with.
 *
 * **The real token, not a masked view.** `getSettings()` deliberately masks a
 * secret in `resolved` (the Google Books key's rule, because that view is the
 * UI's), so routing the server through it would have it compare against
 * `••••` — which is the whole reason this resolver exists rather than a second
 * read of `CONFIG_KEYS` inside `api/rest.ts`.
 *
 * Storage is not trusted on the read path: the port is re-checked against its
 * range and falls back to the default when a hand-edited row holds nonsense —
 * the same shape `theme_tokens` is re-validated on every read with, and the
 * only one of these four whose stored form can make `listen()` throw.
 */
export function resolveRestApiConfig(): ResolvedRestApiConfig {
  return {
    enabled: getConfig(REST_API_CONFIG_KEYS.enabled) === 'true',
    port: resolveRestApiPort(getConfig(REST_API_CONFIG_KEYS.port)),
    bind: getConfig(REST_API_CONFIG_KEYS.bind)?.trim() ?? '',
    token: getConfig(REST_API_CONFIG_KEYS.token)?.trim() || null
  }
}

function resolveRestApiPort(stored: string | null): number {
  const port = stored ? Number(stored) : NaN
  return Number.isInteger(port) && port >= MIN_REST_API_PORT && port <= MAX_REST_API_PORT
    ? port
    : DEFAULT_REST_API_PORT
}
