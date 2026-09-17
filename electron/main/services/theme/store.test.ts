import { mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredTheme, ThemeTokens } from '@shared/theme.types'
import { closeDb, deleteConfig, getConfig, getDb, setConfig } from '../db'
import { deriveTheme, loadThemeText, THEME_ENGINE_VERSION } from './index'
import {
  activeTheme,
  BUILTIN_THEME_SOURCES,
  DEFAULT_THEME_ID,
  getThemeView,
  MUSAEUM_DEFAULT_TOKENS,
  setTheme,
  THEME_LIBRARY_KEY,
  windowBackgroundColor
} from './store'

/**
 * Slice 3's contract: what is stored, what is applied, and what happens when the
 * stored row is not what this engine would have written.
 *
 * Every case here goes through a real `app_config` (a throwaway `userData` from
 * the Electron mock), because the store's whole job is the boundary between a
 * row on disk and what the app renders — a stubbed database would decide none of
 * it.
 */

const THEME_DIR = join(process.cwd(), 'electron', 'main', 'services', 'theme')
const BUILTIN = join(THEME_DIR, 'builtin')
const MAIN_INDEX = join(process.cwd(), 'electron', 'main', 'index.ts')
const ROOT_CSS = join(process.cwd(), 'src', 'index.css')

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
})

/** The two stored keys, as bytes — what a rejection has to leave alone. */
function storedPair(): { id: string | null; tokens: string | null } {
  return { id: getConfig('theme_id'), tokens: getConfig('theme_tokens') }
}

function storedTokensRaw(): string {
  const raw = getConfig('theme_tokens')
  if (raw === null) throw new Error('nothing is stored')
  return raw
}

function storedRecord(): StoredTheme {
  return JSON.parse(storedTokensRaw()) as StoredTheme
}

/** A token set derived through the same front door the store uses. */
function derivedTokens(stem: string): ThemeTokens {
  const text = BUILTIN_THEME_SOURCES[stem]
  if (text === undefined) throw new Error(`no builtin source for ${stem}`)
  const loaded = loadThemeText(`${stem}.yaml`, text)
  if (!loaded.ok) throw new Error(`${stem} did not load: ${loaded.reason}`)
  const derived = deriveTheme(loaded.ir)
  if (!derived.ok) throw new Error(`${stem} did not derive`)
  return derived.tokens
}

/** A hand-written row — the only way to reach an engine-version mismatch. */
function handWrittenRow(id: string, engineVersion: number): StoredTheme {
  const hand: StoredTheme = { ...storedRecord(), id, engineVersion }
  setConfig('theme_id', id)
  setConfig('theme_tokens', JSON.stringify(hand))
  return hand
}

// --- D1: the default is src/index.css's :root, restated -----------------------

function rootVars(): Record<string, string> {
  const css = readFileSync(ROOT_CSS, 'utf8')
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)
  if (!block) throw new Error('src/index.css has no :root block')
  const vars: Record<string, string> = {}
  for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) vars[m[1]] = m[2].trim()
  return vars
}

/** A hex colour as the channel triplet `:root` stores it in. */
function asChannels(hex: string): string {
  const body = hex.replace(/^#/, '')
  return [0, 2, 4].map((at) => parseInt(body.slice(at, at + 2), 16)).join(' ')
}

describe('D1 — the built-in default is the :root block, restated', () => {
  const vars = rootVars()
  const varsCount = Object.keys(vars).length

  it('parses the :root block at all', () => {
    // Every assertion below reads this map, so a parse that goes empty would make
    // them all vacuous. `:root` carries 19 properties (14 palette channels +
    // on-accent + scrim + the three slice-5 shadow alphas).
    expect(varsCount).toBe(19)
    expect(vars['--ink-950']).toBeDefined()
  })

  it('matches every palette channel', () => {
    for (const step of ['950', '900', '850', '800', '700', '600', '500']) {
      expect(
        asChannels(MUSAEUM_DEFAULT_TOKENS.ink[step as keyof typeof MUSAEUM_DEFAULT_TOKENS.ink])
      ).toBe(vars[`--ink-${step}`])
    }
    expect(asChannels(MUSAEUM_DEFAULT_TOKENS.parchment.parchment)).toBe(vars['--parchment'])
    expect(asChannels(MUSAEUM_DEFAULT_TOKENS.parchment.parchment_dim)).toBe(vars['--parchment-dim'])
    expect(asChannels(MUSAEUM_DEFAULT_TOKENS.parchment.parchment_faint)).toBe(
      vars['--parchment-faint']
    )
    for (const step of ['300', '400', '500', '600']) {
      expect(
        asChannels(MUSAEUM_DEFAULT_TOKENS.gold[step as keyof typeof MUSAEUM_DEFAULT_TOKENS.gold])
      ).toBe(vars[`--gold-${step}`])
    }
  })

  it('matches on-accent and keeps the scrim byte-equal to ink-950', () => {
    expect(asChannels(MUSAEUM_DEFAULT_TOKENS.on_acc)).toBe(vars['--on-accent'])
    expect(asChannels(MUSAEUM_DEFAULT_TOKENS.scrim)).toBe(vars['--scrim'])
    expect(MUSAEUM_DEFAULT_TOKENS.scrim).toBe(MUSAEUM_DEFAULT_TOKENS.ink['950'])
  })

  it("carries the engine's dark shadow strength", () => {
    // The annex's D1 asks this pin to compare "the shadow strength" against
    // `:root` — but `:root` holds three authored alphas (0.5/0.35/0.6) and the
    // token set holds the derivation's dark strength (0.55), so the two are not
    // equal and cannot be. What is checkable is that the default's strength is
    // the one `derive.ts` emits for a dark canvas, which is what this pins.
    expect(MUSAEUM_DEFAULT_TOKENS.shadow).toBe(0.55)
    expect(derivedTokens('gruvbox-dark-hard').shadow).toBe(MUSAEUM_DEFAULT_TOKENS.shadow)
    expect(MUSAEUM_DEFAULT_TOKENS.dark).toBe(true)
    for (const alpha of ['--shadow-a1', '--shadow-a2', '--shadow-a3']) {
      expect(Number(vars[alpha])).not.toBe(MUSAEUM_DEFAULT_TOKENS.shadow)
    }
  })

  it('omits the status family (D2)', () => {
    expect('status' in MUSAEUM_DEFAULT_TOKENS).toBe(false)
  })
})

// --- D6: the registry is the corpus on disk -----------------------------------

describe('D6 — the inlined registry is the corpus on disk', () => {
  it('lists exactly the .yaml stems in builtin/', () => {
    const stems = readdirSync(BUILTIN)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''))
      .sort()
    expect(stems).toHaveLength(13)
    expect(Object.keys(BUILTIN_THEME_SOURCES).sort()).toEqual(stems)
  })

  it('derives every built-in through the real write path', () => {
    for (const stem of Object.keys(BUILTIN_THEME_SOURCES)) {
      const result = setTheme(`builtin:${stem}`)
      if (!result.ok) throw new Error(`builtin:${stem} was rejected: ${result.reason}`)
      expect(getConfig('theme_id')).toBe(`builtin:${stem}`)
      expect(activeTheme().engineVersion).toBe(THEME_ENGINE_VERSION)
    }
  })
})

// --- AC3.1(a): the window colour follows the theme ----------------------------

describe('AC3.1(a) — the window background is a function of the tokens', () => {
  it('is the default canvas for the built-in default', () => {
    expect(windowBackgroundColor(MUSAEUM_DEFAULT_TOKENS)).toBe('#0d0b09')
  })

  it("is a light theme's own ink-950, not the dark default", () => {
    const light = derivedTokens('solarized-light')
    expect(light.ink['950']).toBe('#fdf6e3')
    expect(light.dark).toBe(false)
    expect(windowBackgroundColor(light)).toBe('#fdf6e3')
    expect(windowBackgroundColor(light)).not.toBe(windowBackgroundColor(MUSAEUM_DEFAULT_TOKENS))
  })

  it('tracks the stored theme after a set', () => {
    expect(windowBackgroundColor(activeTheme().tokens)).toBe('#0d0b09')
    setTheme('builtin:solarized-light')
    expect(windowBackgroundColor(activeTheme().tokens)).toBe('#fdf6e3')
  })
})

// --- AC3.1(b): createWindow() reads it ----------------------------------------

describe('AC3.1(b) — createWindow() takes its colour from the theme service', () => {
  const source = readFileSync(MAIN_INDEX, 'utf8')
  const start = source.indexOf('new BrowserWindow(')
  const end = source.indexOf('win.on(', start)
  const options = source.slice(start, end)

  it('slices out the constructor options', () => {
    // A slice that silently found nothing would satisfy both assertions below.
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(options).toContain('webPreferences')
    expect(options).toContain('minWidth')
  })

  it('passes windowBackgroundColor(activeTheme().tokens)', () => {
    expect(options).toMatch(/backgroundColor:\s*windowBackgroundColor\(activeTheme\(\)\.tokens\)/)
  })

  it('carries no hex literal in the options object', () => {
    expect(options).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

// --- AC3.2: one write path, both keys, atomically -----------------------------

describe('AC3.2 — one write path, both keys, atomically', () => {
  it('writes theme_id and theme_tokens in agreement', () => {
    const result = setTheme('builtin:solarized-light')
    if (!result.ok) throw new Error(`expected a success, got ${result.reason}`)
    expect(getConfig('theme_id')).toBe('builtin:solarized-light')
    expect(storedRecord().id).toBe(getConfig('theme_id'))
    expect(result.view.active.id).toBe(getConfig('theme_id'))
    expect(activeTheme().tokens.ink['950']).toBe('#fdf6e3')
  })

  it('stores the default as the absence of both keys (D4), and still reports it active', () => {
    setTheme('builtin:gruvbox-dark-hard')
    expect(getConfig('theme_id')).not.toBeNull()
    const result = setTheme(DEFAULT_THEME_ID)
    if (!result.ok) throw new Error(`expected a success, got ${result.reason}`)
    expect(getConfig('theme_id')).toBeNull()
    expect(getConfig('theme_tokens')).toBeNull()
    expect(result.view.active.id).toBe(DEFAULT_THEME_ID)
    expect(activeTheme().tokens).toEqual(MUSAEUM_DEFAULT_TOKENS)
  })

  it('writes both keys inside one transaction', () => {
    // The pair is written id-first, so a database that refuses the *second*
    // write is the one witness that can tell "one transaction" from "two
    // autocommitted statements": with the wrapper, the refusal rolls the id
    // back; without it, the id is already committed and the app points at a
    // theme whose tokens never landed.
    getDb().exec(
      "CREATE TRIGGER theme_tokens_poison BEFORE INSERT ON app_config WHEN NEW.key = 'theme_tokens' BEGIN SELECT RAISE(ABORT, 'poisoned by the test'); END"
    )
    expect(() => setTheme('builtin:solarized-light')).toThrow()
    expect(storedPair()).toEqual({ id: null, tokens: null })
  })

  it('leaves the pair byte-identical after a rejection', () => {
    setTheme('builtin:solarized-light')
    const before = storedPair()
    const result = setTheme('obsidian:Broken')
    if (result.ok) throw new Error('expected obsidian:Broken to be rejected')
    expect(storedPair()).toEqual(before)
  })

  it('reports the built-in default’s id as the view’s defaultId, in every read path', () => {
    // `defaultId` is what slice 4's picker marks as the default row: without this
    // pin it is decided by nothing — measured, `getThemeView` returning
    // `'builtin:nonsense'` left the whole suite green. Asserted across the three
    // read paths (nothing stored, a theme stored, a degraded row) because the
    // field rides on the view, not on the active theme.
    expect(getThemeView().defaultId).toBe(DEFAULT_THEME_ID)

    setTheme('builtin:gruvbox-dark-hard')
    expect(getThemeView().defaultId).toBe(DEFAULT_THEME_ID)

    setConfig('theme_id', 'builtin:solarized-light')
    setConfig('theme_tokens', 'not json')
    const degraded = getThemeView()
    expect(degraded.active.id).toBe(DEFAULT_THEME_ID)
    expect(degraded.defaultId).toBe(DEFAULT_THEME_ID)
  })
})

// --- AC3.3: a rejected theme changes nothing ----------------------------------

describe('AC3.3 — a rejected theme changes nothing', () => {
  it('names the unresolvable id in the reason and writes nothing', () => {
    setTheme('builtin:gruvbox-dark-hard')
    const before = storedPair()
    const result = setTheme('obsidian:Broken')
    if (result.ok) throw new Error('expected a rejection')
    expect(result.reason).toContain('obsidian:Broken')
    expect(storedPair()).toEqual(before)
  })

  it('rejects an unknown built-in stem the same way', () => {
    setTheme('builtin:solarized-light')
    const before = storedPair()
    const result = setTheme('builtin:not-a-theme')
    if (result.ok) throw new Error('expected a rejection')
    expect(result.reason).toContain('builtin:not-a-theme')
    expect(storedPair()).toEqual(before)
  })

  it('rejects an empty id', () => {
    const result = setTheme('')
    if (result.ok) throw new Error('expected a rejection')
    expect(result.reason).toContain('No such theme')
  })

  it('rejects an id that is not a provider prefix', () => {
    const result = setTheme('gruvbox-dark-hard')
    if (result.ok) throw new Error('expected a rejection')
    expect(result.reason).toContain('gruvbox-dark-hard')
  })

  it('leaves the pair untouched from a clean database too', () => {
    const result = setTheme('obsidian:Broken')
    if (result.ok) throw new Error('expected a rejection')
    expect(storedPair()).toEqual({ id: null, tokens: null })
  })
})

// --- AC3.4: storage is not trusted --------------------------------------------

describe('AC3.4 — storage is not trusted', () => {
  const BAD_TOKENS = ['', 'not json', '{"tokens":{"ink":{"950":"#0d0b09"}}}']

  it.each(BAD_TOKENS)('degrades %j to the built-in default', (raw) => {
    setConfig('theme_id', 'builtin:solarized-light')
    setConfig('theme_tokens', raw)
    const view = getThemeView()
    expect(view.active.id).toBe(DEFAULT_THEME_ID)
    expect(view.active.tokens).toEqual(MUSAEUM_DEFAULT_TOKENS)
    expect(windowBackgroundColor(view.active.tokens)).toBe('#0d0b09')
  })

  /** The reason a read degraded, captured from the log rather than thrown. */
  function degradedReason(): string {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getThemeView()
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    warn.mockRestore()
    return logged
  }

  /**
   * A record the engine wrote, with fields hand-edited. `record` patches the
   * top level, `tokens` the nested token set — so a case about `tokens.shadow`
   * reaches that check rather than degrading on a missing `tokens.ink`.
   */
  function tampered(record: Record<string, unknown>, tokens: Record<string, unknown> = {}): void {
    setTheme('builtin:gruvbox-dark-hard')
    const stored = JSON.parse(storedTokensRaw()) as Record<string, unknown>
    setConfig(
      'theme_tokens',
      JSON.stringify({
        ...stored,
        ...record,
        tokens: { ...(stored.tokens as Record<string, unknown>), ...tokens }
      })
    )
  }

  /**
   * The rule is *every value the derivation emits*, not "every value present".
   *
   * A row with complete metadata whose `tokens.gold` is incomplete would
   * otherwise validate, and the apply path would write no `--gold-500/600` at
   * all — leaving those channels on `:root`'s values: a half-coloured theme,
   * silently, with a green suite.
   *
   * **The subject has to be a family that is present but incomplete.** Deleting
   * the whole `gold` key degrades on the `isObject` guard above and never reaches
   * the step walk — measured: written that way first, the mutation below stayed
   * green (44 passed). So each case drops one step *inside* a present family,
   * which is the only shape that separates the walk from the guard.
   */
  it.each([
    ['tokens.gold.600', 'gold', '600'],
    ['tokens.ink.500', 'ink', '500'],
    ['tokens.parchment.parchment_faint', 'parchment', 'parchment_faint']
  ])('degrades a record missing %s, not just a missing field', (expected, family, step) => {
    setTheme('builtin:gruvbox-dark-hard')
    const stored = JSON.parse(storedTokensRaw()) as {
      tokens: Record<string, Record<string, string>>
    }
    const bucket = { ...stored.tokens[family] }
    delete bucket[step]
    setConfig(
      'theme_tokens',
      JSON.stringify({ ...stored, tokens: { ...stored.tokens, [family]: bucket } })
    )
    const view = getThemeView()
    expect(view.active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain(expected)
  })

  it('degrades a record whose top-level variant is not a variant', () => {
    tampered({ variant: 'sepia' })
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain("variant is not 'dark' or 'light'")
  })

  it('degrades a record whose id disagrees with theme_id', () => {
    setTheme('builtin:gruvbox-dark-hard')
    setConfig('theme_id', 'builtin:solarized-light')
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain('does not match theme_id')
  })

  it('degrades a pair with one key missing, in either direction', () => {
    setTheme('builtin:gruvbox-dark-hard')
    deleteConfig('theme_id')
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain('theme_id is absent')

    closeDb()
    rmSync(join(app.getPath('userData'), 'musaeum.db'), { force: true })
    setConfig('theme_id', 'builtin:gruvbox-dark-hard')
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain('theme_tokens is absent')
  })

  it.each([
    ['an uppercase hex', { ink: { '950': '#0D0B09' } }, 'tokens.ink.950'],
    ['a shadow outside [0,1]', { shadow: 1.5 }, 'tokens.shadow'],
    ['a shadow that is not a number', { shadow: null }, 'tokens.shadow'],
    ['a string dark', { dark: 'true' }, 'tokens.dark']
  ])('degrades a record with %s, naming that field', (_label, tokens, field) => {
    tampered({}, tokens as Record<string, unknown>)
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain(field)
  })

  it('degrades a row whose shadow is a JSON number that is not finite', () => {
    // NaN and the infinities have no JSON spelling, so a hand-edited row reaches
    // them the way this does — as an exponent JSON.parse resolves past the
    // float range. `1e999` would pass a `< floor` test by being false.
    setTheme('builtin:gruvbox-dark-hard')
    setConfig('theme_tokens', storedTokensRaw().replace('"shadow":0.55', '"shadow":1e999'))
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain('tokens.shadow')
  })

  it('degrades a record whose variant disagrees with tokens.dark', () => {
    // `dark` is what decides the direction of every ramp in the derivation, so a
    // record spelling it two ways is not usable — the app would render one
    // polarity's ladder under the other's name.
    tampered({ variant: 'light' }, { dark: true })
    expect(getThemeView().active.id).toBe(DEFAULT_THEME_ID)
    expect(degradedReason()).toContain('disagrees with tokens.dark')
  })

  it('logs the reason instead of throwing it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setConfig('theme_id', 'builtin:solarized-light')
    setConfig('theme_tokens', 'not json')
    expect(() => getThemeView()).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('theme_tokens is not JSON')
    warn.mockRestore()
  })

  it('keeps the bad row rather than deleting it', () => {
    setConfig('theme_id', 'builtin:solarized-light')
    setConfig('theme_tokens', 'not json')
    getThemeView()
    expect(storedPair()).toEqual({ id: 'builtin:solarized-light', tokens: 'not json' })
  })

  it('renders today’s pixels: the degraded view carries exactly the default tokens', () => {
    setConfig('theme_id', 'builtin:solarized-light')
    setConfig('theme_tokens', '')
    expect(getThemeView().active.tokens).toEqual(MUSAEUM_DEFAULT_TOKENS)
  })
})

// --- AC3.4: an inherited object key is not a theme ----------------------------

describe('AC3.4 — an inherited object key is not a registered theme', () => {
  /**
   * The registry is a plain object literal, so `BUILTIN_THEME_SOURCES['__proto__']`
   * is `Object.prototype` and `['constructor']` is a function: both are truthy and
   * neither is `undefined`, so a lookup guarded only by `text === undefined` hands
   * a non-string to `loadThemeText`, whose base16 arm calls `text.match` and whose
   * iTerm arm `text.slice`s. Two reachable routes, both in this threat model:
   * (a) a hand-edited `app_config` row whose `theme_id` is `builtin:__proto__`
   * with a well-formed record and `engineVersion: 0`, which drives the ladder's
   * `resolveId` from `readStored`, and (b)
   * `window.Musaeum.theme.set('builtin:__proto__')` from the renderer. Both arms
   * are asserted here.
   *
   * (a) is the fatal one: `activeTheme()` is called from `createWindow()` at
   * `electron/main/index.ts:100`, inside `app.whenReady().then(...)` with no
   * `catch`, so a throw there opens no window at all and the user cannot repair
   * the row from inside the app — `CLAUDE.md` #12, and this file's own docblock.
   */
  const INHERITED_KEYS = ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']

  it('is not in the registry, by the registry’s own names', () => {
    // Non-vacuity for the cases below: the authority is own-property membership,
    // and these keys are exactly the ones a bare lookup resolves up the chain.
    for (const stem of INHERITED_KEYS) {
      expect(Object.hasOwn(BUILTIN_THEME_SOURCES, stem), stem).toBe(false)
      expect(BUILTIN_THEME_SOURCES[stem], stem).not.toBe(undefined)
    }
  })

  it.each(INHERITED_KEYS)(
    'does not throw on a stored theme_id of builtin:%s, and still has a window colour',
    (stem) => {
      setTheme('builtin:gruvbox-dark-hard')
      const hand = handWrittenRow(`builtin:${stem}`, 0)

      // The defect was the throw, and the throw is what decides this: pre-fix,
      // `getThemeView()` and `activeTheme()` both raised
      // `TypeError: text.match is not a function`. What comes back now is J3's
      // kept-and-stale arm — an id this engine cannot re-derive keeps the values
      // that are stored (`tokens` is a validated record, so it renders) and the
      // picker flags the row, rather than the app losing it.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let view: ReturnType<typeof getThemeView> | undefined
      let theme: StoredTheme | undefined
      expect(() => {
        view = getThemeView()
      }).not.toThrow()
      expect(() => {
        theme = activeTheme()
      }).not.toThrow()
      warn.mockRestore()

      if (!view || !theme) throw new Error('the read did not return')
      expect(view.stale).toBe(true)
      expect(view.active.id).toBe(`builtin:${stem}`)
      expect(view.active.tokens).toEqual(hand.tokens)
      expect(theme.tokens).toEqual(hand.tokens)
      // The boot path's whole requirement: `createWindow()` gets a colour.
      expect(windowBackgroundColor(theme.tokens)).toBe(hand.tokens.ink['950'])
    }
  )

  it.each(INHERITED_KEYS)('rejects set(%j) as an unknown theme rather than throwing', (stem) => {
    let result: ReturnType<typeof setTheme> | undefined
    expect(() => {
      result = setTheme(`builtin:${stem}`)
    }).not.toThrow()
    if (!result) throw new Error('setTheme did not return')
    if (result.ok) throw new Error(`expected a rejection for builtin:${stem}`)
    expect(result.reason).toContain(`builtin:${stem}`)
    expect(storedPair()).toEqual({ id: null, tokens: null })
  })
})

// --- Invariant 12: a database that cannot be opened is not a startup failure ---

describe('invariant 12 — an unopenable database degrades the read, it does not throw', () => {
  /**
   * `activeRead()` guarded `readStored`'s *return* values, not exceptions.
   * `readStored` calls `getConfig`, which calls `getDb()`, which throws when the
   * file cannot be opened. `activeTheme()` is on the window-creation path
   * (`electron/main/index.ts:100`), so before this case a broken database meant
   * **no window** — where the rest of the app reports database failures as IPC
   * failures and keeps its window.
   *
   * A directory where the database file must be is the reproducible shape: it
   * cannot be opened, and unlike a permission bit it survives being run as root.
   * The directory is removed in `finally` — this file's `beforeEach` clears files,
   * not directories.
   */
  it('returns the built-in default instead of throwing', () => {
    const dbPath = join(app.getPath('userData'), 'musaeum.db')
    closeDb()
    rmSync(dbPath, { force: true })
    mkdirSync(dbPath)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      let theme: StoredTheme | undefined
      let view: ReturnType<typeof getThemeView> | undefined
      expect(() => {
        theme = activeTheme()
      }).not.toThrow()
      expect(() => {
        view = getThemeView()
      }).not.toThrow()
      warn.mockRestore()

      if (!theme || !view) throw new Error('the read did not return')
      expect(theme.tokens).toEqual(MUSAEUM_DEFAULT_TOKENS)
      expect(theme.id).toBe(DEFAULT_THEME_ID)
      expect(view.active.tokens).toEqual(MUSAEUM_DEFAULT_TOKENS)
      expect(windowBackgroundColor(theme.tokens)).toBe('#0d0b09')
    } finally {
      closeDb()
      rmSync(dbPath, { recursive: true, force: true })
    }
  })

  it('names the failure in the log rather than swallowing it silently', () => {
    const dbPath = join(app.getPath('userData'), 'musaeum.db')
    closeDb()
    rmSync(dbPath, { force: true })
    mkdirSync(dbPath)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      activeTheme()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('[theme]')
    } finally {
      warn.mockRestore()
      closeDb()
      rmSync(dbPath, { recursive: true, force: true })
    }
  })
})

// --- J3: an engine-version mismatch is not a validation failure ---------------

describe('J3 — an engine-version mismatch is not a validation failure', () => {
  it('re-derives a builtin id, rewrites both keys, and is not stale', () => {
    setTheme('builtin:solarized-light')
    handWrittenRow('builtin:solarized-light', 0)

    const view = getThemeView()
    expect(view.stale).toBe(false)
    expect(view.active.id).toBe('builtin:solarized-light')
    expect(view.active.engineVersion).toBe(THEME_ENGINE_VERSION)
    expect(view.active.tokens.ink['950']).toBe('#fdf6e3')
    // Both keys were rewritten, not just returned.
    expect(storedRecord().engineVersion).toBe(THEME_ENGINE_VERSION)
    expect(activeTheme().engineVersion).toBe(THEME_ENGINE_VERSION)
  })

  it('re-derives the default id by removing both keys', () => {
    setTheme('builtin:gruvbox-dark-hard')
    handWrittenRow(DEFAULT_THEME_ID, 0)

    const view = getThemeView()
    expect(view.stale).toBe(false)
    expect(view.active.id).toBe(DEFAULT_THEME_ID)
    expect(storedPair()).toEqual({ id: null, tokens: null })
  })

  it('keeps the stored values for an id it cannot re-derive, and reports stale', () => {
    setTheme('builtin:solarized-light')
    const hand = handWrittenRow('iterm:Nord', 0)
    const before = storedPair()

    const view = getThemeView()
    expect(view.stale).toBe(true)
    expect(view.active.id).toBe('iterm:Nord')
    expect(view.active.engineVersion).toBe(0)
    expect(view.active.tokens.ink['950']).toBe(hand.tokens.ink['950'])
    // Kept means kept: the row is not rewritten.
    expect(storedPair()).toEqual(before)
  })

  it('re-derives even when the rewrite cannot land, rather than failing the read', () => {
    // The ladder's re-derive arm is the one read that writes. `activeTheme()` is
    // called from `createWindow()`, so a database that refuses that write must
    // not be able to stop the app from starting.
    setTheme('builtin:solarized-light')
    handWrittenRow('builtin:solarized-light', 0)
    getDb().pragma('query_only = ON')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let view: ReturnType<typeof getThemeView> | undefined
    expect(() => {
      view = getThemeView()
    }).not.toThrow()
    warn.mockRestore()

    // The rewrite really was refused — otherwise this case would pass on the arm
    // it is meant to exclude.
    expect(storedRecord().engineVersion).toBe(0)
    if (!view) throw new Error('the read did not return a view')
    expect(view.stale).toBe(false)
    expect(view.active.engineVersion).toBe(THEME_ENGINE_VERSION)
    expect(view.active.tokens.ink['950']).toBe('#fdf6e3')
  })
})

// --- D3: theme_library is read and preserved ----------------------------------

describe('D3 — theme_library survives every write path', () => {
  const LIBRARY = JSON.stringify([
    { id: 'iterm:Proton', name: 'Proton', engineVersion: THEME_ENGINE_VERSION, tokens: {} }
  ])

  it('is preserved byte-identically by a set, and by the default’s delete', () => {
    setConfig(THEME_LIBRARY_KEY, LIBRARY)
    setTheme('builtin:gruvbox-dark-hard')
    expect(getConfig(THEME_LIBRARY_KEY)).toBe(LIBRARY)
    setTheme(DEFAULT_THEME_ID)
    expect(getConfig(THEME_LIBRARY_KEY)).toBe(LIBRARY)
  })

  it('uses a comparison that can notice a change', () => {
    // Non-vacuity: the assertion above is byte equality, so it must fail on a
    // single byte of difference — which slice 4's importer writing the key, or a
    // set that cleared unfamiliar keys, would produce.
    setConfig(THEME_LIBRARY_KEY, LIBRARY)
    setConfig(THEME_LIBRARY_KEY, `${LIBRARY} `)
    expect(getConfig(THEME_LIBRARY_KEY)).not.toBe(LIBRARY)
  })
})
