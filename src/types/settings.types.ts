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
    pythonPath: ResolvedSetting
    ebookConvertPath: ResolvedSetting
    googleBooksApiKey: ResolvedSetting
  }
}

/** Executables the settings modal can browse for. */
export type ExecutableKind = 'python' | 'ebookConvert'
