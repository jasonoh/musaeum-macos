import type { StoredTheme, ThemeProvider, ThemeTokens, ThemeView } from '@shared/theme.types'
// The engine's front door, so the version constant and the derivation are the
// same ones a provider file goes through — no second path to keep in step.
import { deriveTheme, loadThemeText, THEME_ENGINE_VERSION } from './index'
import { deleteConfig, getConfig, getDb, setConfig } from '../db'
import catppuccinLatte from './builtin/catppuccin-latte.yaml?raw'
import catppuccinMocha from './builtin/catppuccin-mocha.yaml?raw'
import dracula from './builtin/dracula.yaml?raw'
import everforestDarkHard from './builtin/everforest-dark-hard.yaml?raw'
import gruvboxDarkHard from './builtin/gruvbox-dark-hard.yaml?raw'
import gruvboxLightSoft from './builtin/gruvbox-light-soft.yaml?raw'
import kanagawa from './builtin/kanagawa.yaml?raw'
import nord from './builtin/nord.yaml?raw'
import rosePineMoon from './builtin/rose-pine-moon.yaml?raw'
import solarizedDark from './builtin/solarized-dark.yaml?raw'
import solarizedLight from './builtin/solarized-light.yaml?raw'
import tokyoNightDark from './builtin/tokyo-night-dark.yaml?raw'
import tokyoNightLight from './builtin/tokyo-night-light.yaml?raw'

/**
 * The active theme: what is stored, what the default is, and the one colour main
 * needs before the window exists.
 *
 * Three things this file is careful about:
 *
 * 1. **Storage is not trusted.** `theme_tokens` is re-parsed and re-validated on
 *    every read, and anything short of a complete, well-formed record is treated
 *    as *no theme*: the built-in default applies and the app keeps running.
 *    Nothing here throws (`CLAUDE.md` #12) — a hand-edited or half-written row
 *    must never be able to render an unreadable app.
 * 2. **One write path owns both keys.** `theme.set` derives and validates
 *    *before* it opens a transaction, then writes `theme_id` and `theme_tokens`
 *    inside one `getDb().transaction(...)`, so the selector the picker shows and
 *    the values the app renders can never disagree.
 * 3. **The corpus is inlined.** The built-ins are `?raw` imports, not a runtime
 *    `readFileSync`: `out/main/index.js` is the whole main process in dev and in
 *    a packaged build, and `builtin/` ships in neither.
 */

export const DEFAULT_THEME_ID = 'builtin:musaeum'

/** The default's display name — the picker's row for it. */
export const DEFAULT_THEME_NAME = 'Musaeum'

const THEME_ID_KEY = 'theme_id'
const THEME_TOKENS_KEY = 'theme_tokens'

/**
 * A JSON array of resolved records for themes that are not active. Slice 3
 * **reads and preserves** it and never writes it: slice 4's importer is its only
 * writer, and a `set` that clobbered it would lose the whole library on the
 * second pick.
 */
export const THEME_LIBRARY_KEY = 'theme_library'

/**
 * The built-in default, as tokens: `src/index.css`'s `:root` restated.
 *
 * An explicit constant rather than an absence, so the default goes through the
 * same apply path as any other theme — `windowBackgroundColor` of it is
 * `#0d0b09`, and no literal of that colour is left in `electron/main/index.ts`.
 * `theme/store.test.ts` pins it against `:root` itself, so the duplicate cannot
 * drift. `status` is absent on purpose: slice 7a owns `:root`'s status values.
 */
export const MUSAEUM_DEFAULT_TOKENS: ThemeTokens = {
  ink: {
    '950': '#0d0b09',
    '900': '#14110d',
    '850': '#191511',
    '800': '#201b15',
    '700': '#2b241c',
    '600': '#3b3226',
    '500': '#4f4433'
  },
  parchment: {
    parchment: '#e9e1d2',
    parchment_dim: '#b3a78f',
    parchment_faint: '#7d7260'
  },
  gold: {
    '300': '#e8c987',
    '400': '#d4a24e',
    '500': '#c08f3a',
    '600': '#9c7028'
  },
  // Byte-equal to ink-950 by design, as the veils are pixel-identical until
  // they migrate.
  on_acc: '#0d0b09',
  scrim: '#0d0b09',
  // The engine's own shadow strength for a dark canvas (`derive.ts`), not one of
  // `:root`'s three authored alphas — those belong to slice 5.
  shadow: 0.55,
  dark: true
}

/**
 * The vendored corpus, one static `?raw` import per file, keyed by the file's
 * stem: `'solarized-light'` → the text of `builtin/solarized-light.yaml`. The
 * map is explicit so it is greppable, and so `store.test.ts` can pin its keys
 * against the `.yaml` stems actually on disk (a corpus that grows or shrinks
 * cannot silently drift out of the registry).
 *
 * **Look it up with `builtinSource`, never with a bare `[...]`.** It is a plain
 * object literal, so a bare lookup resolves *inherited* keys too:
 * `BUILTIN_THEME_SOURCES['__proto__']` is `Object.prototype` and
 * `['constructor']` is a function — neither is `undefined`, so a guard written
 * as `text === undefined` passes them through to `loadThemeText`, which calls
 * `.match`/`.slice` on them and throws. That throw would come out of
 * `activeTheme()`, which `createWindow()` calls inside `app.whenReady().then()`
 * with no `catch`: a hand-edited `theme_id` of `builtin:__proto__` would open
 * **no window at all**.
 */
export const BUILTIN_THEME_SOURCES: Record<string, string> = {
  'catppuccin-latte': catppuccinLatte,
  'catppuccin-mocha': catppuccinMocha,
  dracula,
  'everforest-dark-hard': everforestDarkHard,
  'gruvbox-dark-hard': gruvboxDarkHard,
  'gruvbox-light-soft': gruvboxLightSoft,
  kanagawa,
  nord,
  'rose-pine-moon': rosePineMoon,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  'tokyo-night-dark': tokyoNightDark,
  'tokyo-night-light': tokyoNightLight
}

/**
 * The registry's one lookup: the source text for a built-in stem, or `null`.
 *
 * Own properties only, and the value's type re-checked. `Object.hasOwn` is the
 * authority — not `text === undefined`, which is true for a missing stem and
 * false for `__proto__`/`constructor`/`toString`/`valueOf`/`hasOwnProperty`,
 * every one of which is a name a `theme_id` can spell.
 */
function builtinSource(stem: string): string | null {
  if (!Object.hasOwn(BUILTIN_THEME_SOURCES, stem)) return null
  const text: unknown = BUILTIN_THEME_SOURCES[stem]
  return typeof text === 'string' ? text : null
}

const PROVIDERS: readonly ThemeProvider[] = ['base16', 'itermcolors', 'obsidian', 'native']
const INK_STEPS = ['950', '900', '850', '800', '700', '600', '500'] as const
const GOLD_STEPS = ['300', '400', '500', '600'] as const
const PARCHMENT_KEYS = ['parchment', 'parchment_dim', 'parchment_faint'] as const
const STATUS_FAMILIES = ['danger', 'ok', 'warn'] as const
const STATUS_STEPS = ['400', '500', '600', 'on'] as const
const HEX = /^#[0-9a-f]{6}$/

/** The built-in default, as a resolved record. */
function defaultTheme(): StoredTheme {
  return {
    id: DEFAULT_THEME_ID,
    name: DEFAULT_THEME_NAME,
    author: 'Musaeum',
    provider: 'native',
    variant: 'dark',
    sourcePath: null,
    engineVersion: THEME_ENGINE_VERSION,
    tokens: MUSAEUM_DEFAULT_TOKENS,
    audits: [],
    adjustments: [],
    notes: []
  }
}

function colourProblem(label: string, value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value)
    ? null
    : `${label} is not a lowercase #rrggbb colour (got ${JSON.stringify(value)})`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every value the derivation emits, re-checked. `null` when it is usable;
 * otherwise the reason it is not.
 *
 * The rule is *every value the derivation emits*, not "every value present":
 * the 7 ink steps, the 3 parchment stops, the 4 gold steps, `on_acc`, `scrim`,
 * `shadow` and `dark` are all **required**, so a row that arrived with a colour
 * family missing degrades instead of rendering half of `:root`'s palette inside
 * a theme. It is written as a walk over the step lists rather than a hardcoded
 * count so slice 7a's status family is covered by the same rule when it lands
 * instead of quietly bypassing validation. `status` alone is optional, because
 * the built-in default predates 7a's `:root` values. Extra keys are ignored — an
 * unknown key cannot make a token set render wrong.
 */
function recordProblem(value: unknown, expectedId: string | null): string | null {
  if (!isObject(value)) return 'the stored theme is not an object'
  const record = value

  if (typeof record.id !== 'string' || record.id === '') return 'id is not a non-empty string'
  if (expectedId !== null && record.id !== expectedId) {
    return `the record's id ${JSON.stringify(record.id)} does not match theme_id ${JSON.stringify(expectedId)}`
  }
  if (typeof record.name !== 'string') return 'name is not a string'
  if (typeof record.author !== 'string') return 'author is not a string'
  if (!PROVIDERS.includes(record.provider as ThemeProvider)) {
    return `provider is not one of ${PROVIDERS.join(', ')}`
  }
  if (record.variant !== 'dark' && record.variant !== 'light') {
    return `variant is not 'dark' or 'light' (got ${JSON.stringify(record.variant)})`
  }
  if (record.sourcePath !== null && typeof record.sourcePath !== 'string') {
    return 'sourcePath is neither a string nor null'
  }
  if (
    typeof record.engineVersion !== 'number' ||
    !Number.isInteger(record.engineVersion) ||
    !Number.isFinite(record.engineVersion)
  ) {
    return `engineVersion is not a finite integer (got ${JSON.stringify(record.engineVersion)})`
  }
  for (const [label, field] of [
    ['audits', record.audits],
    ['adjustments', record.adjustments],
    ['notes', record.notes]
  ] as const) {
    if (!Array.isArray(field)) return `${label} is not an array`
  }

  const tokens = record.tokens
  if (!isObject(tokens)) return 'tokens is not an object'

  const ink = tokens.ink
  if (!isObject(ink)) return 'tokens.ink is not an object'
  for (const step of INK_STEPS) {
    const problem = colourProblem(`tokens.ink.${step}`, ink[step])
    if (problem) return problem
  }
  const parchment = tokens.parchment
  if (!isObject(parchment)) return 'tokens.parchment is not an object'
  for (const key of PARCHMENT_KEYS) {
    const problem = colourProblem(`tokens.parchment.${key}`, parchment[key])
    if (problem) return problem
  }
  const gold = tokens.gold
  if (!isObject(gold)) return 'tokens.gold is not an object'
  for (const step of GOLD_STEPS) {
    const problem = colourProblem(`tokens.gold.${step}`, gold[step])
    if (problem) return problem
  }
  for (const [label, field] of [
    ['on_acc', tokens.on_acc],
    ['scrim', tokens.scrim]
  ] as const) {
    const problem = colourProblem(`tokens.${label}`, field)
    if (problem) return problem
  }
  if (typeof tokens.dark !== 'boolean') {
    return `tokens.dark is not a boolean (got ${JSON.stringify(tokens.dark)})`
  }
  // The polarity is what decides every ramp in the derivation, so a record whose
  // two spellings of it disagree is not usable — the lighter of the two would
  // render the app with the other one's ladder.
  if (record.variant !== (tokens.dark ? 'dark' : 'light')) {
    return `variant ${JSON.stringify(record.variant)} disagrees with tokens.dark ${String(tokens.dark)}`
  }
  if (
    typeof tokens.shadow !== 'number' ||
    !Number.isFinite(tokens.shadow) ||
    tokens.shadow < 0 ||
    tokens.shadow > 1
  ) {
    return `tokens.shadow is not a finite number in [0,1] (got ${JSON.stringify(tokens.shadow)})`
  }

  const { status } = tokens
  if (status !== undefined) {
    if (!isObject(status)) return 'tokens.status is not an object'
    for (const family of STATUS_FAMILIES) {
      const ramp = status[family]
      if (!isObject(ramp)) return `tokens.status.${family} is not an object`
      for (const step of STATUS_STEPS) {
        const problem = colourProblem(`tokens.status.${family}.${step}`, ramp[step])
        if (problem) return problem
      }
    }
  }
  return null
}

/** Resolve an id to a record — the whole registry slice 3 has. */
function resolveId(id: string): { ok: true; theme: StoredTheme } | { ok: false; reason: string } {
  if (id === DEFAULT_THEME_ID) return { ok: true, theme: defaultTheme() }
  if (!id.startsWith('builtin:')) return { ok: false, reason: `No such theme: ${id}` }

  const stem = id.slice('builtin:'.length)
  const text = builtinSource(stem)
  if (text === null) return { ok: false, reason: `No such theme: ${id}` }

  const loaded = loadThemeText(`${stem}.yaml`, text)
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  const derived = deriveTheme(loaded.ir)
  if (!derived.ok) {
    const { reason } = derived
    return {
      ok: false,
      reason:
        reason.kind === 'floor'
          ? `${id}: ${reason.role} measured ${reason.ratio}, below its floor of ${reason.floor}`
          : `${id}: ${reason.role} — ${reason.detail}`
    }
  }
  return {
    ok: true,
    theme: {
      id,
      name: loaded.ir.name,
      author: loaded.ir.author,
      provider: loaded.ir.source,
      variant: loaded.ir.variant,
      // The corpus is inlined, so a built-in has no file on disk to point at.
      sourcePath: null,
      engineVersion: THEME_ENGINE_VERSION,
      tokens: derived.tokens,
      audits: derived.audits,
      adjustments: derived.adjusted,
      notes: [...loaded.ir.notes, ...derived.notes]
    }
  }
}

/**
 * The one write path. Both keys, one transaction — and for the default, neither
 * key: "the built-in default is active" has exactly one representation, not two.
 */
function writeTheme(theme: StoredTheme): void {
  getDb().transaction(() => {
    if (theme.id === DEFAULT_THEME_ID) {
      deleteConfig(THEME_ID_KEY)
      deleteConfig(THEME_TOKENS_KEY)
      return
    }
    setConfig(THEME_ID_KEY, theme.id)
    setConfig(THEME_TOKENS_KEY, JSON.stringify(theme))
  })()
}

type StoredRead = { ok: true; theme: StoredTheme; stale: boolean } | { ok: false; reason: string }

/**
 * What is stored, or the reason it is unusable.
 *
 * An engine-version mismatch is **not** a validation failure. If the id can be
 * re-derived from the bundle, re-derive it and rewrite both keys; otherwise keep
 * the stored values and say they are stale, so the picker can flag the row
 * rather than the app losing a theme it can still render.
 */
function readStored(): StoredRead {
  const id = getConfig(THEME_ID_KEY)
  const raw = getConfig(THEME_TOKENS_KEY)
  // Nothing stored is the built-in default, not a broken pair.
  if (id === null && raw === null) return { ok: true, theme: defaultTheme(), stale: false }
  if (id === null || raw === null) {
    return {
      ok: false,
      reason: `theme_id and theme_tokens disagree: ${id === null ? 'theme_id' : 'theme_tokens'} is absent`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `theme_tokens is not JSON: ${detail}` }
  }

  const problem = recordProblem(parsed, id)
  if (problem) return { ok: false, reason: `theme_tokens is not usable: ${problem}` }

  const stored = parsed as StoredTheme
  if (stored.engineVersion === THEME_ENGINE_VERSION) {
    return { ok: true, theme: stored, stale: false }
  }

  const rederived = resolveId(stored.id)
  if (!rederived.ok) return { ok: true, theme: stored, stale: true }
  try {
    writeTheme(rederived.theme)
  } catch (err) {
    // This read writes, which is the one surprising thing in the ladder. It must
    // not be able to fail the read: the values in hand are the ones this engine
    // derives today, and a database that refuses the rewrite leaves the row as
    // the stale one it already was (the next boot tries again). `activeTheme` is
    // called from `createWindow()`, where a throw means no window at all.
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[theme] could not rewrite the re-derived theme: ${detail}`)
  }
  return { ok: true, theme: rederived.theme, stale: false }
}

/**
 * The read, degraded to the default with its reason logged. Never throws.
 *
 * The `catch` is load-bearing for the same reason the ladder's rewrite has one:
 * `readStored` only *returns* reasons for the rows it can read, so a database
 * that cannot be opened escapes it as an exception from `getConfig` →
 * `getDb()`. `activeTheme()` is called from `createWindow()` at
 * `electron/main/index.ts:100`, inside `app.whenReady().then(...)` with no
 * `catch` — so an unopenable database would mean no window at all, where before
 * this slice it got a window and surfaced database errors as IPC failures.
 */
function activeRead(): { theme: StoredTheme; stale: boolean } {
  let read: StoredRead
  try {
    read = readStored()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(
      `[theme] the stored theme could not be read: ${detail} — using the built-in default`
    )
    return { theme: defaultTheme(), stale: false }
  }
  if (read.ok) return read
  console.warn(`[theme] ${read.reason} — using the built-in default`)
  return { theme: defaultTheme(), stale: false }
}

/** The stored theme, or the default when nothing usable is stored. Never throws. */
export function activeTheme(): StoredTheme {
  return activeRead().theme
}

/** Read-only view for the renderer. Never throws; a bad row degrades to the default. */
export function getThemeView(): ThemeView {
  const { theme, stale } = activeRead()
  return { active: theme, defaultId: DEFAULT_THEME_ID, stale }
}

/**
 * Derive → validate → write both keys in ONE transaction → return the new view.
 * A rejection returns `{ ok: false, reason }` and writes nothing.
 *
 * The validation is ahead of the transaction on purpose: the natural order
 * (write the id, then derive) is how a bad theme leaves the app pointing at a
 * theme it cannot render.
 */
export function setTheme(
  id: string
): { ok: true; view: ThemeView } | { ok: false; reason: string } {
  const resolved = resolveId(id)
  if (!resolved.ok) return resolved

  // Deriving and validating are separate guarantees: the derivation decides what
  // a theme *is*, this decides that what came back is a record main can hand to a
  // renderer that trusts it. Nothing in today's registry can fail this (a
  // derivation only ever emits values that pass), so it has no witness yet — it
  // is here so a future adapter cannot write a row the reader would reject.
  const problem = recordProblem(resolved.theme, resolved.theme.id)
  if (problem) return { ok: false, reason: `${id}: ${problem}` }

  writeTheme(resolved.theme)
  return { ok: true, view: getThemeView() }
}

/** Pure. The colour `new BrowserWindow` is constructed with. */
export function windowBackgroundColor(tokens: ThemeTokens): string {
  return tokens.ink['950']
}
