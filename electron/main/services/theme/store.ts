import { app } from 'electron'
import { extname, join } from 'path'
import type {
  StoredTheme,
  ThemeIr,
  ThemeOption,
  ThemeProvider,
  ThemeSwatches,
  ThemeTokens,
  ThemeView
} from '@shared/theme.types'
// The engine's front door, so the version constant, the parser dispatch and the
// derivation are the same ones a provider file goes through — no second path to
// keep in step, and `loadThemeFile` is reused by the ladder's re-derive arm.
import { deriveTheme, loadThemeFile, loadThemeText, THEME_ENGINE_VERSION } from './index'
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
 * The active theme, the imported library, and the one colour main needs before
 * the window exists.
 *
 * Four things this file is careful about:
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
 * 3. **The imported library follows those same two rules.** `theme_library` is an
 *    array of records in exactly the active theme's shape; it is re-validated on
 *    every read (an entry the reader refuses is dropped, with the reason logged)
 *    and written by one read-modify-write transaction that upserts by id. It is
 *    the picker's storage, and it is what lets an imported theme be applied after
 *    its source file has moved away.
 * 4. **The corpus is inlined.** The built-ins are `?raw` imports, not a runtime
 *    `readFileSync`: `out/main/index.js` is the whole main process in dev and in
 *    a packaged build, and `builtin/` ships in neither.
 */

export const DEFAULT_THEME_ID = 'builtin:musaeum'

/** The default's display name — the picker's row for it. */
export const DEFAULT_THEME_NAME = 'Musaeum'

const THEME_ID_KEY = 'theme_id'
const THEME_TOKENS_KEY = 'theme_tokens'

/**
 * A JSON array of resolved records for themes that are not active — the picker's
 * own storage.
 *
 * Two writers, both narrow: the importer's `upsertLibrary` (add and update) and
 * the ladder's re-derive arm (rewrite one entry in place). `theme.set` does not
 * touch it, and it is not read while writing `theme_tokens`, because a `set` that
 * clobbered the key would lose the whole library on the second pick.
 */
export const THEME_LIBRARY_KEY = 'theme_library'

/**
 * The drop-box directory: `userData/themes`, where a provider file can be
 * dropped and picked up by `theme:scanFolder`.
 *
 * The app never writes a file *into* it — an import derives a theme's values and
 * stores those, so a source file that moves away afterwards is not an error. The
 * one thing it may do *to* the folder is create it, so *Reveal in Finder* works
 * before the first import; that mkdir lives in the IPC layer's `openFolder`, and
 * nothing on the read path creates it (a missing folder is an empty scan).
 */
export function themeFolder(): string {
  return join(app.getPath('userData'), 'themes')
}

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

/**
 * The built-in default, as a resolved record.
 *
 * `variant` is `'dark'` because `MUSAEUM_DEFAULT_TOKENS.dark` is true — the two
 * spellings of the polarity are pinned together by `recordProblem`, so the
 * picker's variant badge and the ladder's flag cannot disagree.
 */
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

/**
 * The imported library, as the rows the reader accepts.
 *
 * Validated on every read, because storage is not trusted
 * (`invariants/settings-and-editing.md`): a non-array or non-JSON value is an
 * empty library with the reason logged, and an entry `recordProblem` refuses is
 * **dropped**, with the reason logged. Dropping is the point rather than a
 * shortcut — a row the reader would reject can never be applied, so carrying it
 * in the list would only move the failure to the click. The dropped row is left in
 * the key, and the next write is what removes it: `upsertLibrary` rebuilds the key
 * from the rows this function hands back, so a row the reader refuses survives
 * exactly until the next import (that is deliberate — see that function).
 *
 * Total: nothing here throws (`CLAUDE.md` #12). This is read on the boot path's
 * view, where a throw would mean the renderer gets no theme at all.
 */
export function readLibrary(): StoredTheme[] {
  let raw: string | null
  try {
    raw = getConfig(THEME_LIBRARY_KEY)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[theme] the imported themes could not be read: ${detail}`)
    return []
  }
  if (raw === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[theme] theme_library is not JSON: ${detail} — treating it as empty`)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.warn('[theme] theme_library is not an array — treating it as empty')
    return []
  }

  const library: StoredTheme[] = []
  for (const entry of parsed) {
    // A library row's expected id is its own: it is not compared against
    // `theme_id`, it *is* the source of truth for its namespace.
    const ownId = isObject(entry) && typeof entry.id === 'string' ? entry.id : null
    const problem = recordProblem(entry, ownId)
    if (problem) {
      console.warn(`[theme] dropping a theme_library row: ${problem}`)
      continue
    }
    library.push(entry as StoredTheme)
  }
  return library
}

/**
 * Add or replace library rows: one transaction, read-modify-write, upsert by id
 * (replace in place, append when new).
 *
 * Validate-before-write, the same ordering `setTheme` uses and for the same
 * reason — the natural order (write, then check) is how a row the reader refuses
 * ends up in storage. An invalid incoming record is a *caller's bug* rather than
 * a value to report, so it throws: the importer builds records through
 * `storedRecordOf` and the ladder re-derives through the same function, so
 * neither can hand this one a record its own reader would drop.
 *
 * The read is `readLibrary`, which means a value the reader cannot use is
 * *replaced* by the next write instead of being preserved. That is deliberate:
 * the alternative is a key that can never be repaired, and every row that
 * survives the read survives the write with its values unchanged.
 */
export function upsertLibrary(records: StoredTheme[]): void {
  // Nothing to write is not the same as writing an empty library: an import that
  // imported nothing must not create the key.
  if (records.length === 0) return

  for (const record of records) {
    const problem = recordProblem(record, record.id)
    if (problem) throw new Error(`refusing to store ${record.id}: ${problem}`)
  }

  getDb().transaction(() => {
    const library = readLibrary()
    const at = new Map(library.map((theme, index) => [theme.id, index]))
    for (const record of records) {
      const index = at.get(record.id)
      if (index === undefined) {
        at.set(record.id, library.length)
        library.push(record)
      } else {
        library[index] = record
      }
    }
    setConfig(THEME_LIBRARY_KEY, JSON.stringify(library))
  })()
}

/** A resolved record, or the reason there is none. `stale` is J3's flag. */
type ResolveResult =
  { ok: true; theme: StoredTheme; stale: boolean } | { ok: false; reason: string }

/**
 * One IR, derived and assembled into the record the library and the active key
 * both store — the single place that mapping lives.
 *
 * Three callers: `resolveId`'s registry arm (the inlined corpus), `resolveId`'s
 * library arm re-deriving an imported file, and the importer. They must agree
 * field for field — the re-derive-on-version-mismatch path is exactly where an
 * imported record and a freshly derived one meet, and a second copy of this
 * mapping is how they start to differ in a field nobody looks at.
 *
 * `id` and `sourcePath` are the caller's because only the caller knows the
 * namespace (`builtin:`, `base16:`, `iterm:`) and whether there is a file behind
 * the values; the IR itself carries neither.
 */
export function storedRecordOf(
  ir: ThemeIr,
  id: string,
  sourcePath: string | null
): { ok: true; theme: StoredTheme } | { ok: false; reason: string } {
  const derived = deriveTheme(ir)
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
      name: ir.name,
      author: ir.author,
      provider: ir.source,
      variant: ir.variant,
      sourcePath,
      engineVersion: THEME_ENGINE_VERSION,
      tokens: derived.tokens,
      audits: derived.audits,
      adjustments: derived.adjusted,
      notes: [...ir.notes, ...derived.notes]
    }
  }
}

/**
 * A library entry's source file, re-read and re-derived, or `null` when it
 * cannot be.
 *
 * `null` covers the three cases whose remedy is the same one — "no file to read",
 * "the file has moved", "the file is no longer a palette this engine can read" —
 * and the caller's answer to all three is J3's: keep what is stored and say it is
 * stale. A *derivation* failure (floors the palette no longer meets) lands in the
 * same arm for the same reason: the stored values are what the app has been
 * rendering, and dropping the theme is worse than flagging it.
 */
/** The one extension whose values cannot be re-derived from its bytes. */
const RESOLVER_ONLY_EXTENSION = '.css'

function rederiveFromFile(path: string, id: string): StoredTheme | null {
  // **An Obsidian row is never re-derived from its file** (D6). Its values only
  // exist inside a live cascade — the resolver window has to *run* the stylesheet
  // (§2.6/D1) — and this function sits inside `resolveId`, which is on the
  // click's critical path: `theme.set` must not depend on a hidden browser
  // window, let alone on one that is not up yet (J4, AC4.5). J3's answer is what
  // the caller does with a `null` here: keep the stored values and flag the row
  // stale, so the picker can say "derived by an older engine" instead of the app
  // losing a theme it can still render. A fresh read of a theme folder is an
  // import, not something a click does.
  //
  // Guarded by *extension* rather than by id because the id's namespace is the
  // importer's rule, while the stylesheet is the file this function cannot read:
  // without the guard the read below would still be refused one line later
  // (`loadThemeText` has no `.css` arm on purpose), but it would have read the
  // bytes off disk first, on a click.
  if (extname(path).toLowerCase() === RESOLVER_ONLY_EXTENSION) {
    console.warn(`[theme] ${id} is an Obsidian theme — keeping its stored values, not re-reading`)
    return null
  }
  const loaded = loadThemeFile(path)
  if (!loaded.ok) {
    console.warn(`[theme] could not re-read ${id} from ${path}: ${loaded.reason}`)
    return null
  }
  const built = storedRecordOf(loaded.ir, id, path)
  if (!built.ok) {
    console.warn(`[theme] could not re-derive ${id}: ${built.reason}`)
    return null
  }
  return built.theme
}

/** The library's own lookup, by exact id, over rows that validated on the way out. */
function libraryRecord(id: string): StoredTheme | null {
  for (const record of readLibrary()) if (record.id === id) return record
  return null
}

/**
 * Resolve an id to a record. The ladder is default → `builtin:` → library, and
 * every imported id starts `base16:`/`iterm:` while every built-in starts
 * `builtin:`, so the registry can never be shadowed (D2).
 *
 * The library is the one arm that can *write*: an entry whose `engineVersion` is
 * not this engine's is re-derived from its `sourcePath` when that file is still
 * readable, and the rewrite goes through the same one-transaction path an import
 * uses. When the file is gone, the stored values are kept and the result is
 * flagged `stale` (J3) — because `theme.set` must not depend on a file that may
 * have moved (J4), and applying a theme is on the click's critical path (AC4.5).
 *
 * An entry's re-validation is `readLibrary`'s and happens on every lookup: a
 * second copy of the rule here would be a second thing to keep in step, and a
 * dropped row resolves to the same `No such theme` an id that never existed does
 * — a record the reader refuses can never become the active theme.
 */
function resolveId(id: string): ResolveResult {
  if (id === DEFAULT_THEME_ID) return { ok: true, theme: defaultTheme(), stale: false }

  if (id.startsWith('builtin:')) {
    const stem = id.slice('builtin:'.length)
    const text = builtinSource(stem)
    if (text === null) return { ok: false, reason: `No such theme: ${id}` }

    const loaded = loadThemeText(`${stem}.yaml`, text)
    if (!loaded.ok) return { ok: false, reason: loaded.reason }
    const built = storedRecordOf(loaded.ir, id, null)
    if (!built.ok) return built
    return { ok: true, theme: built.theme, stale: false }
  }

  const stored = libraryRecord(id)
  if (stored === null) return { ok: false, reason: `No such theme: ${id}` }
  if (stored.engineVersion === THEME_ENGINE_VERSION) {
    return { ok: true, theme: stored, stale: false }
  }

  const rederived = stored.sourcePath === null ? null : rederiveFromFile(stored.sourcePath, id)
  if (rederived === null) return { ok: true, theme: stored, stale: true }

  try {
    upsertLibrary([rederived])
  } catch (err) {
    // The ladder's second write, and it is guarded for the same reason the first
    // one is: this read is reached from `createWindow()` (through `activeTheme`),
    // so a database that refuses the rewrite must leave the *values in hand* as
    // they were — they are this engine's own derivation, and the next read tries
    // again.
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[theme] could not rewrite the re-derived ${id}: ${detail}`)
  }
  return { ok: true, theme: rederived, stale: false }
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

/**
 * What is stored, or the reason it is unusable.
 *
 * An engine-version mismatch is **not** a validation failure. If the id can be
 * re-derived — from the bundle for a built-in, from its source file for an
 * imported one — re-derive it and rewrite both keys; otherwise keep the stored
 * values and say they are stale, so the picker can flag the row rather than the
 * app losing a theme it can still render.
 */
function readStored(): ResolveResult {
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
  // A *stale* resolution is the same answer as no resolution: the values in hand
  // are the ones the app has been rendering, and `theme_tokens` is not rewritten
  // behind an id the library could not bring up to date.
  if (!rederived.ok || rederived.stale) return { ok: true, theme: stored, stale: true }
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
  let read: ResolveResult
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

/**
 * The five derived values a picker row shows, in `ThemeSwatches`' fixed order:
 * `ink-950`, `ink-800`, `parchment`, `gold-400`, `gold-500`. Enough to tell two
 * dark themes apart in a list without rendering a preview, and a fixed order so a
 * row is comparable with the row above it.
 */
function swatchesOf(tokens: ThemeTokens): ThemeSwatches {
  return [
    tokens.ink['950'],
    tokens.ink['800'],
    tokens.parchment.parchment,
    tokens.gold['400'],
    tokens.gold['500']
  ]
}

/**
 * One picker row, from one record.
 *
 * `stale` is D9's per-row flag: the values in this row were not written by this
 * engine. Whether they can still be brought up to date is decided when the theme
 * is applied (`resolveId` re-derives from `sourcePath` when the file is there) —
 * the row's own flag is about the values it is showing now, which is what the
 * picker can honestly say without re-deriving 13 rows to fill a list.
 */
function optionRow(theme: StoredTheme, active: boolean): ThemeOption {
  return {
    id: theme.id,
    name: theme.name,
    author: theme.author,
    provider: theme.provider,
    variant: theme.variant,
    swatches: swatchesOf(theme.tokens),
    active,
    stale: theme.engineVersion !== THEME_ENGINE_VERSION,
    notes: theme.notes,
    sourcePath: theme.sourcePath
  }
}

let builtinRows: readonly ThemeOption[] | null = null

/**
 * The 13 vendored schemes as rows, derived once per process (D11).
 *
 * `theme:get` is awaited on the boot path *before* the first paint
 * (`src/main.tsx`), and a row is a derivation: rebuilding 13 of them on every
 * view would put a picker's worth of work on the boot's own budget. The memo key
 * is the stem and nothing here can invalidate it — the corpus is inlined,
 * immutable, and never written to storage.
 *
 * The returned array and its rows are **frozen**: the identity of the array is
 * the memo's own witness (`store.test.ts` asserts it), so a caller that stamped
 * `active` onto a memoized row instead of copying it would poison every later
 * view. Copying a row is what `getThemeView` does.
 */
export function builtinOptionRows(): readonly ThemeOption[] {
  builtinRows ??= Object.freeze(buildBuiltinRows())
  return builtinRows
}

/**
 * A built-in that cannot derive is **skipped with its reason**, never thrown: the
 * corpus is pinned against the engine in `derive.test.ts`, and one file this
 * engine cannot read must not be able to empty the picker — or, since this runs
 * on the view, to fail the boot path.
 */
function buildBuiltinRows(): readonly ThemeOption[] {
  const rows: ThemeOption[] = []
  for (const stem of Object.keys(BUILTIN_THEME_SOURCES)) {
    const resolved = resolveId(`builtin:${stem}`)
    if (!resolved.ok) {
      console.warn(`[theme] builtin:${stem} could not be derived: ${resolved.reason}`)
      continue
    }
    rows.push(Object.freeze(optionRow(resolved.theme, false)))
  }
  return Object.freeze(rows)
}

/**
 * Read-only view for the renderer: the active theme, every row the picker can
 * offer, and the drop-box folder. Never throws; a bad row degrades to the
 * default.
 *
 * Rows are the built-in default first (the authored constant, not a derivation),
 * then the vendored corpus, then the library in stored order. Exactly one row is
 * `active` — the one the app is on, which for a row that is not in any list is no
 * row at all.
 *
 * The order of the two reads is load-bearing: `activeRead` may re-derive the
 * active theme and rewrite its library entry, so reading the library *after* it
 * is what keeps the active row's engine version honest.
 */
export function getThemeView(): ThemeView {
  const { theme, stale } = activeRead()
  const library = readLibrary()
  return {
    active: theme,
    defaultId: DEFAULT_THEME_ID,
    stale,
    options: [
      optionRow(defaultTheme(), theme.id === DEFAULT_THEME_ID),
      ...builtinOptionRows().map((row) => ({ ...row, active: row.id === theme.id })),
      ...library.map((record) => optionRow(record, record.id === theme.id))
    ],
    folder: themeFolder()
  }
}

/**
 * Derive → validate → write both keys in ONE transaction → return the new view.
 * A rejection returns `{ ok: false, reason }` and writes nothing.
 *
 * The validation is ahead of the transaction on purpose: the natural order
 * (write the id, then derive) is how a bad theme leaves the app pointing at a
 * theme it cannot render.
 *
 * An imported id resolves out of the library, and applying one can therefore
 * write a second place — `resolveId` rewrites a library entry it had to
 * re-derive. That is the same values this engine would have derived, written by
 * the same one-transaction path an import uses, and it happens before either
 * key is touched: a write that cannot land throws out of `writeTheme` with the
 * stored pair untouched.
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

/**
 * Pure. Which way the platform's *own* chrome points for a set of tokens.
 *
 * The platform paints some of Musaeum and will not take a colour for it: native
 * scrollbars, the traffic lights, the menu bar, the text caret, `<select>` popup
 * lists and the default canvas all follow `nativeTheme.themeSource` and nothing
 * else. `:root`'s `color-scheme` covers the web-content half of that list
 * (slice 1 owns its default, the renderer's apply path owns the transition);
 * this function is the main-process half, which the renderer cannot reach.
 *
 * It is a pure function *here* rather than two lines in
 * `electron/main/index.ts` because `index.ts` has no harness: importing it under
 * vitest runs its `whenReady` microtasks, which reach `services/menu.ts` and
 * exit 1 before `createWindow()` is ever called — the A25 precedent in
 * `docs/superpowers/specs/theming.md`. A decision inside an unimportable file is
 * a decision no test can falsify; this one is decided by its own unit case, and
 * the wiring that calls it is decided by a source walk (AC5.5).
 *
 * `dark` is the token set's own boolean — the same one the reader's page palette
 * resolves the book document's `color-scheme` from, so the app's chrome and the
 * page inside it cannot point opposite ways.
 */
export function nativeScheme(tokens: ThemeTokens): 'light' | 'dark' {
  return tokens.dark ? 'dark' : 'light'
}
