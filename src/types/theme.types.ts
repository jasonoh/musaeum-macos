/**
 * The theming contracts, shared by main and renderer (`@shared/theme.types` is
 * the one alias both tsconfigs carry).
 *
 * The IR keeps `derive.py`'s field spelling verbatim, snake_case included. The
 * Python prototype in `~/theme-probe` is the reference for every rule here, and
 * a port that renames its fields can no longer be diffed against it. These are
 * also the keys slice 6's Obsidian adapter must fill.
 */

export type ThemeVariant = 'dark' | 'light'
export type ThemeProvider = 'base16' | 'itermcolors' | 'obsidian' | 'native'
export type InkStep = '950' | '900' | '850' | '800' | '700' | '600' | '500'
export type GoldStep = '300' | '400' | '500' | '600'
export type AccentSlot =
  'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'purple' | 'brown'
export type StatusFamily = 'danger' | 'ok' | 'warn'

/** An sRGB triple, each channel 0..1 — the prototype's own representation. */
export type Rgb = [number, number, number]

/**
 * One provider palette, normalized. Every provider's lossiness is confined to
 * the step that produces this shape.
 */
export interface ThemeIr {
  name: string
  author: string
  variant: ThemeVariant
  source: ThemeProvider
  bg: string
  bg2: string
  bg3: string
  border: string
  muted: string
  fg: string
  fg_bright: string
  /** All eight slots are always present; a provider that omits one is rejected. */
  accents: Record<AccentSlot, string>
  accent_hint: string
  /**
   * Set only by the Obsidian adapter: an observed role beats a derived one, so
   * a provider that names its on-accent text (Obsidian's `--text-on-accent`)
   * overrides the derivation when it holds the floor.
   */
  on_acc_hint?: string
  notes: string[]
}

/** One status family: `400` is the text step, `500`/`600` are fills. */
export interface StatusRamp {
  '400': string
  '500': string
  '600': string
  on: string
}

export interface DerivedTokens {
  ink: Record<InkStep, string>
  parchment: { parchment: string; parchment_dim: string; parchment_faint: string }
  gold: Record<GoldStep, string>
  on_acc: string
  scrim: string
  status: Record<StatusFamily, StatusRamp>
  shadow: number
  dark: boolean
}

export interface ThemeAudit {
  name: string
  ratio: number
  floor: number
}

/**
 * A floor the derivation could not meet. Carried as a value, never thrown:
 * `CLAUDE.md` #12 keeps failures non-fatal, so a theme that cannot be made
 * readable is reported and the app keeps the palette it already had.
 */
export type FloorFailure = { role: string; ratio: number; floor: number }

/**
 * Which scale a rejection's `ratio` and `floor` are on. Every contrast floor is a
 * WCAG contrast ratio; the scrim's is an absolute relative luminance, which is a
 * different quantity entirely. A caller that formats both as "ratio (min floor)"
 * prints nonsense for one of them, so the scale travels with the failure.
 */
export type FloorMetric = 'contrast' | 'luminance'

/** A floor that was measured and missed. */
export type FloorReason = FloorFailure & { kind: 'floor'; metric: FloorMetric }

/**
 * The derivation could not measure. `role` names the offending IR field
 * (`'bg'`, `'accents.orange'`) rather than a token role — under this kind there
 * is no measured ratio to report, because the input never got that far.
 */
export type MalformedReason = { kind: 'malformed'; role: string; detail: string }

/**
 * Why a derivation failed, discriminated on `kind` so a caller cannot read
 * `ratio`/`floor` off a rejection that was never measured.
 */
export type DeriveFailure = FloorReason | MalformedReason

/**
 * The whole derivation. `adjusted` and `notes` ride along on both arms because
 * the caller reports them either way — on a rejection they say how far the
 * derivation got and why the floors could not be met.
 */
export type DeriveResult =
  | { ok: true; tokens: DerivedTokens; audits: ThemeAudit[]; adjusted: string[]; notes: string[] }
  | { ok: false; reason: DeriveFailure; adjusted: string[]; notes: string[] }

/** A provider file, read. A malformed one is reported with a named reason. */
export type LoadedTheme = { ok: true; ir: ThemeIr } | { ok: false; reason: string }

/**
 * A token set as persisted and applied: the derivation with the status family
 * optional.
 *
 * `DerivedTokens` is untouched — a derivation always emits `status`. The one set
 * that does not is the built-in default (`MUSAEUM_DEFAULT_TOKENS`), which is
 * `src/index.css`'s `:root` restated, and `:root` has no status values yet:
 * slice 7a owns them, so nothing may pre-commit them here. The apply path writes
 * a status variable only when the set carries one.
 */
export interface ThemeTokens extends Omit<DerivedTokens, 'status'> {
  status?: Record<StatusFamily, StatusRamp>
}

/**
 * One resolved theme, as stored. `engineVersion` is the `THEME_ENGINE_VERSION`
 * that produced `tokens`, so a set written by older rules can be told from one
 * this engine would derive today. `sourcePath` is for display only — never
 * re-read to render: an imported `.itermcolors` may not be on disk any more.
 */
export interface StoredTheme {
  id: string
  name: string
  author: string
  provider: ThemeProvider
  variant: ThemeVariant
  sourcePath: string | null
  engineVersion: number
  tokens: ThemeTokens
  audits: ThemeAudit[]
  adjustments: string[]
  notes: string[]
}

/**
 * The five derived values a picker row shows, in this order:
 * `ink-950`, `ink-800`, `parchment`, `gold-400`, `gold-500`.
 *
 * Five, not seventeen: they are enough to tell two dark themes apart in a list
 * without rendering a preview, and the order is fixed so a row is comparable
 * with the row above it. A tuple rather than `string[]` so "five" is a type and
 * not a promise a row-builder can quietly stop keeping.
 */
export type ThemeSwatches = [string, string, string, string, string]

/**
 * One row the picker can offer. Built-in rows are derived from the inlined
 * corpus; imported rows come from `theme_library`'s stored values, so a row
 * survives its source file being moved or deleted (J4).
 */
export interface ThemeOption {
  /** `builtin:<stem>`, `base16:<stem>`, `iterm:<stem>` — the id `theme.set` takes. */
  id: string
  name: string
  author: string
  provider: ThemeProvider
  variant: ThemeVariant
  swatches: ThemeSwatches
  active: boolean
  /**
   * The values in this row were written by another engine
   * (`engineVersion !== THEME_ENGINE_VERSION`). They still render, and applying
   * the theme re-derives them from its source file if that file is still readable
   * — whether it is is decided at that moment, not here, because building the
   * picker must not go and stat every row's source. A row that cannot be brought
   * up to date still applies, from the values it already has.
   */
  stale: boolean
  /** The lossy steps this theme's own derivation had to take. */
  notes: string[]
  /** Display only — never re-read to render. Null for the inlined built-ins. */
  sourcePath: string | null
}

/** A file that was imported and derived. */
export interface ImportedTheme {
  id: string
  name: string
  provider: ThemeProvider
  variant: ThemeVariant
}

/** A file that was not imported, with the reason the engine gave. */
export interface RejectedTheme {
  path: string
  reason: string
}

/**
 * What an import reports. **The view rides along** so the rows the user is
 * looking at and the files that were just imported are one answer rather than
 * two that can disagree — the same reasoning that puts `theme_id` and
 * `theme_tokens` in one transaction. Partial success is normal and not an error:
 * a batch of five files with one malformed member reports four imported and one
 * rejected, and never aborts on the first failure (AC4.2).
 */
export interface ThemeImportResult {
  view: ThemeView
  imported: ImportedTheme[]
  rejected: RejectedTheme[]
}

/**
 * What the renderer is handed. `stale` is true only when stored values were kept
 * across an engine-version mismatch — the picker flags the row with it.
 */
export interface ThemeView {
  active: StoredTheme
  defaultId: string
  stale: boolean
  /**
   * Every theme the picker can offer: the built-in default first, then the
   * vendored corpus, then whatever has been imported.
   */
  options: ThemeOption[]
  /**
   * The drop-box directory (`userData/themes`). The picker shows it and can
   * reveal it; nothing is ever copied or written *into* it — the app derives a
   * theme's values and stores those, so a missing source file is not an error.
   */
  folder: string
}
