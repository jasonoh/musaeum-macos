/**
 * Settings contract — the `app_config` keys a user can change from the UI.
 *
 * Every field is the *configured* value: null means "not set", which is not
 * the same as "not in use". What the app actually runs with is reported
 * separately as a `ResolvedSetting`, because some of these fall back to
 * auto-detection (a venv interpreter) or, for the API key, to the environment.
 */
import type { StorageKind } from './metadata.types'

export interface AppSettings {
  libraryRoot: string | null
  /**
   * What kind of storage the library root sits on (`library_kind`), stored when
   * the folder is chosen. Like `libraryRoot` it is **not** in `EditableSettings`:
   * it has its own flow (the picker resolves it, and the row beside the root
   * reports it), so the batched save must not accept it.
   */
  libraryKind: StorageKind | null
  /**
   * The API surface (slice 1a of the iOS companion,
   * `docs/superpowers/specs/2026-09-22-ios-companion-design.md` D13). All four
   * are `app_config` strings because the table has one column type: the flag is
   * `'true'`/`'false'` rather than a boolean, the port is validated as an
   * integer on write, the token is *generated* on first enable (never typed by
   * hand) and the bind is blank when the address should be resolved from this
   * machine's interfaces. A blank is "not set", which for the flag, the port and
   * the bind all mean the compiled-in behaviour.
   */
  restApiEnabled: string | null
  restApiPort: string | null
  restApiToken: string | null
  restApiBind: string | null
  smbUrl: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiApiKey: string | null
  pythonPath: string | null
  googleBooksApiKey: string | null
}

/**
 * Which settings the save path accepts — `libraryRoot` and `libraryKind` each
 * have their own flow (the picker resolves the kind and writes it beside the
 * root; the row reports both), so the batched save must not accept either.
 */
export type EditableSettings = Omit<AppSettings, 'libraryRoot' | 'libraryKind'>

/** Where the value in force came from. */
export type SettingSource =
  /** Set explicitly in Settings. */
  | 'configured'
  /** Found by the app's own detection (a venv python, the folder's storage kind). */
  | 'auto'
  /** Inherited from the process environment (`infisical run -- npm run dev`). */
  | 'env'
  /** Compiled-in fallback. */
  | 'default'
  /** Nothing in force — the feature that needs it is unavailable. */
  | 'none'

export interface ResolvedSetting {
  /** The value in force. Never the API key itself — see `detail`. */
  value: string | null
  source: SettingSource
  /** Short human-readable note for the UI (masked key, "not found", …). */
  detail?: string
}

/**
 * What the API's socket is doing, as the Settings row renders it.
 *
 * **Restated here rather than imported.** `api/rest.ts` owns this union, but it
 * is a main-process module and the renderer cannot reach one across the bridge
 * — so the row's copy lives with the view it travels in. Drift is a type error
 * rather than a hope: `services/settings.ts` carries a compile-time assertion
 * that the two unions are still the same set of members.
 */
export type RestApiListenState = 'disabled' | 'starting' | 'listening' | 'failed'

/**
 * The socket's own report, carried across the bridge unchanged.
 *
 * Every field is read *from* the listener rather than derived in the renderer:
 * `reason` is documented as "why it is not listening, in words a Settings row
 * can show", and inventing a wording here is exactly what AC27 forbids.
 */
export interface RestApiListenStatus {
  state: RestApiListenState
  /** The address bound, or the one the attempt named. Null when disabled. */
  address: string | null
  /** The port bound, or the one the attempt named. Null when disabled. */
  port: number | null
  /** Why it is not listening, in the socket's own words. Null when it is. */
  reason: string | null
  /** When the last attempt settled (ISO). Null before the first one. */
  at: string | null
}

/**
 * The row's live half, composed in the main process and read whole.
 *
 * The URL is *built here, in main*, because the address it names is resolved
 * from this machine's interfaces — a fact the renderer has no way to hold, and
 * the one thing a second implementation would get subtly wrong (a bracketed
 * IPv6 literal, a port the resolver fell back on).
 */
export interface RestApiView {
  /** The listener's own report (AC27). Never branched on. */
  status: RestApiListenStatus
  /** `http://<address>:<port>` — what to type into the phone, or null when no address resolves. */
  url: string | null
  /** The address the URL names: the stored `rest_api_bind`, or this machine's tailnet address. */
  address: string | null
  /** Which rule chose it: the setting, the tailnet scan, or nothing at all. */
  addressSource: 'override' | 'tailnet' | 'none'
  /** Why there is no address, in the resolver's words. Null when there is one. */
  addressReason: string | null
  /** The port in force — `rest_api_port`, or the compiled-in default. */
  port: number
}

/** One read of everything the settings modal shows. */
export interface SettingsView {
  values: AppSettings
  /**
   * The phone API's live half — the socket's state and the URL to type into the
   * phone. Composed in the main process (D13): the renderer holds no store for
   * any of this, and the row re-reads it rather than remembering it.
   */
  restApi: RestApiView
  /**
   * One line naming the cloud client that syncs the library folder, or null
   * (D7 of `docs/superpowers/specs/2026-09-24-local-library-design.md`).
   *
   * Composed in main like every other sentence a row renders, and for the same
   * reason: whether a path is inside a sync root is a fact about `$HOME`, which
   * the renderer cannot read and has no business holding. It *names* the client
   * and claims only what is known — a refusal is deferred behind a measurement,
   * not a taste.
   */
  syncRootNote: string | null
  resolved: {
    smbUrl: ResolvedSetting
    /**
     * The kind, with where it came from. `auto` because the app resolved it
     * from the folder rather than the user typing it, and `none` until a health
     * check has resolved one — which is the stale case the row exists to make
     * visible (a library that predates the key, or a hand-edited row).
     */
    libraryKind: ResolvedSetting
    aiBaseUrl: ResolvedSetting
    aiModel: ResolvedSetting
    aiApiKey: ResolvedSetting
    pythonPath: ResolvedSetting
    googleBooksApiKey: ResolvedSetting
  }
}

/** Executables the settings modal can browse for. */
export type ExecutableKind = 'python'

/**
 * Progress of the one-time Python environment bootstrap a packaged build runs
 * on first launch (`services/python-env.ts`). Development builds use the
 * repo's `sidecar/.venv` and never emit anything but a terminal state.
 */
export type PythonEnvStage =
  /** Building the venv from a system interpreter. */
  | 'creating'
  /** `pip install -r requirements.txt` — the slow one. */
  | 'installing'
  /** An interpreter with the sidecar's dependencies is in place. */
  | 'ready'
  /** No usable interpreter, or the install failed. Metadata features degrade. */
  | 'failed'

export interface PythonEnvProgress {
  stage: PythonEnvStage
  /** One short line for the status bar. */
  message: string
  /** The reason, when there is one worth showing. */
  detail?: string
}
