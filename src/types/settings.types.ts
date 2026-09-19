/**
 * Settings contract — the `app_config` keys a user can change from the UI.
 *
 * Every field is the *configured* value: null means "not set", which is not
 * the same as "not in use". What the app actually runs with is reported
 * separately as a `ResolvedSetting`, because most of these fall back to
 * auto-detection (a venv interpreter, the standard Calibre install) or, for
 * the API key, to the environment.
 */
export interface AppSettings {
  libraryRoot: string | null
  smbUrl: string | null
  aiBaseUrl: string | null
  aiModel: string | null
  aiApiKey: string | null
  pythonPath: string | null
  ebookConvertPath: string | null
  googleBooksApiKey: string | null
}

/** Which settings the save path accepts — `libraryRoot` has its own flow. */
export type EditableSettings = Omit<AppSettings, 'libraryRoot'>

/** Where the value in force came from. */
export type SettingSource =
  /** Set explicitly in Settings. */
  | 'configured'
  /** Found by the app's own detection (venv python, standard Calibre path). */
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

/** One read of everything the settings modal shows. */
export interface SettingsView {
  values: AppSettings
  resolved: {
    smbUrl: ResolvedSetting
    aiBaseUrl: ResolvedSetting
    aiModel: ResolvedSetting
    aiApiKey: ResolvedSetting
    pythonPath: ResolvedSetting
    ebookConvertPath: ResolvedSetting
    googleBooksApiKey: ResolvedSetting
  }
}

/** Executables the settings modal can browse for. */
export type ExecutableKind = 'python' | 'ebookConvert'

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
