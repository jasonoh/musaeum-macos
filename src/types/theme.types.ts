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
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'brown'
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
