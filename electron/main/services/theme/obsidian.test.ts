import { describe, expect, it } from 'vitest'
import type { ThemeIr } from '@shared/theme.types'
import { loadThemeFileAsync, loadThemeText } from './index'
import {
  OBSIDIAN_ACCENT_LADDER,
  OBSIDIAN_ROLE_LADDER,
  OBSIDIAN_THEME_FILE,
  normalizeColour,
  obsidianIr,
  themeFolderName,
  variantFromCanvas,
  type ObsidianReads
} from './parse/obsidian'
import { resolverRuleFilter, resolverWindowOptions, resolvedEntries } from './resolve-css'

/**
 * Slice 6's adapter, decided entirely by inline read sets.
 *
 * **No user theme file is vendored and none is read from disk.** The read sets
 * below are the *shapes* the resolver measured on this machine — a theme whose
 * roles are all canonical, a theme that declares only Obsidian's `--color-base-*`
 * ramp (Things), and the raw computed declarations a regex scrape would see
 * (which is the AC6.1 mutation) — so the whole rule set has a decider without
 * six megabytes of somebody else's stylesheet in the repo.
 *
 * The resolver's own pure halves (`resolverWindowOptions`, `resolverRuleFilter`,
 * `resolvedEntries`) are here too, and that is legitimate rather than a boundary
 * blurred: `npm test` runs Electron-as-Node, so `BrowserWindow` and `session` do
 * not exist — but these three are *values*, and AC6.5's options half and D5's
 * entry rule are exactly the parts a unit test can decide. The behaviour that
 * needs a real window is the probe's (§7 of the annex).
 */

const PATH = '/Users/me/Projects/vault/.obsidian/themes/halcyon/theme.css'

/** A theme whose every role is declared under Obsidian's canonical name. */
const CANONICAL: ObsidianReads = {
  '--background-secondary': '#0f1117',
  '--background-primary': '#14161f',
  '--background-primary-alt': '#1a1d28',
  '--background-modifier-border': '#262a38',
  '--text-normal': '#e6e6e6',
  '--text-muted': '#9aa0b0',
  '--text-faint': '#6b7280',
  '--interactive-accent': '#d4a24e',
  '--text-on-accent': '#0f1117',
  '--color-red': '#e06c75',
  '--color-orange': '#e5a05a',
  '--color-yellow': '#d4b106',
  '--color-green': '#98c379',
  '--color-cyan': '#56b6c2',
  '--color-blue': '#61afef',
  '--color-purple': '#c678dd',
  '--color-pink': '#e06c9f'
}

/** The same theme, one surface swapped: a canvas that reads *light*. */
const CANONICAL_LIGHT: ObsidianReads = { ...CANONICAL, '--background-secondary': '#f7f7f7' }

/** The nine roles, in the ladder's own order — the count AC6.1 is stated as. */
const ROLES = [
  'canvas',
  'panel',
  'raised',
  'border',
  'text',
  'muted',
  'faint',
  'accent',
  'on_acc'
] as const

/** An IR or a failure that names itself, so a case fails on the reason not a crash. */
function mustIr(reads: ObsidianReads, variantClass: 'dark' | 'light', name = 'halcyon'): ThemeIr {
  const built = obsidianIr(reads, { name, sourcePath: PATH, variantClass })
  if (!built.ok) throw new Error(`expected ${name} to resolve: ${built.reason}`)
  return built.ir
}

/** Every string a payload carries, walked out — AC6.3 is a property of these. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}

// --- AC6.1: a theme resolves that a scrape cannot -----------------------------

describe('AC6.1 — the ladder resolves a theme whose values only exist in a cascade', () => {
  it('resolves all nine roles from canonical-only reads, with nothing to disclose', () => {
    expect(Object.keys(OBSIDIAN_ROLE_LADDER)).toEqual(ROLES)

    expect(mustIr(CANONICAL, 'dark')).toEqual({
      name: 'halcyon',
      author: 'Obsidian theme',
      variant: 'dark',
      source: 'obsidian',
      bg: '#0f1117',
      bg2: '#14161f',
      bg3: '#1a1d28',
      border: '#262a38',
      muted: '#9aa0b0',
      fg: '#e6e6e6',
      // No provider role for "brighter than normal" — the prototype spells the
      // bright end as the normal one, and so does this.
      fg_bright: '#e6e6e6',
      accents: {
        red: '#e06c75',
        orange: '#e5a05a',
        yellow: '#d4b106',
        green: '#98c379',
        cyan: '#56b6c2',
        blue: '#61afef',
        purple: '#c678dd',
        brown: '#e06c9f'
      },
      accent_hint: '#d4a24e',
      on_acc_hint: '#0f1117',
      // Nothing lossy happened: every role resolved on its canonical rung, no
      // alpha was dropped, no accent fell back, and the class agreed with the
      // canvas. An empty `notes` is the assertion that says so.
      notes: []
    })
  })

  it('resolves the same nine roles from the forms Chromium actually hands back', () => {
    // The resolver's probe element resolves `calc()`/`color-mix()`/`var()` before
    // the value reaches `normalizeColour`, so these are the shapes that arrive in
    // production — `rgb()` (both spellings), `color(srgb …)` for a `color-mix()`
    // result, and an 8-digit hex. The regex scrape's own input is the case below.
    const resolvedForms: ObsidianReads = {
      '--background-secondary': 'rgb(15, 17, 23)',
      '--background-primary': 'color(srgb 0.078 0.086 0.121)',
      '--background-primary-alt': 'rgb(26 29 40)',
      '--background-modifier-border': 'rgba(38, 42, 56, 0.9)',
      '--text-normal': '#e6e6e6ff',
      '--text-muted': 'rgb(154, 160, 176)',
      '--text-faint': '#6b7280',
      '--interactive-accent': '#d4a24e',
      '--text-on-accent': 'color(srgb 0.059 0.067 0.09)'
    }
    const ir = mustIr(resolvedForms, 'dark')

    expect(ir.bg).toBe('#0f1117')
    expect(ir.bg2).toBe('#14161f')
    expect(ir.bg3).toBe('#1a1d28')
    expect(ir.border).toBe('#262a38')
    expect(ir.fg).toBe('#e6e6e6')
    expect(ir.muted).toBe('#9aa0b0')
    expect(ir.accent_hint).toBe('#d4a24e')
    expect(ir.on_acc_hint).toBe('#0f1117')
    // All nine roles again — the point of AC6.1 is that none of them is left
    // "computed".
    expect(ir.variant).toBe('dark')
  })

  it('has no answer for a scrape: the raw declarations are computed strings', () => {
    // The mutation AC6.1 names. A regex scrape reads the declarations as written,
    // so it sees `var()` and `calc()` chains — exactly the values `normalizeColour`
    // refuses, because a value that still looks computed is one nobody resolved.
    const scraped: ObsidianReads = {
      '--background-secondary': 'hsl(var(--base-h), calc(var(--base-s) - 4%), var(--base-l))',
      '--background-primary': 'hsl(212, 15%, calc(13% + 65%))',
      '--background-modifier-border': 'color-mix( in hsl, #1d2433, #2f3b54 )',
      '--text-normal': 'var(--color-base-100)',
      '--text-muted': 'hsl(220, 12%, calc(18% - 2%))',
      '--text-faint': 'var(--text-faint)',
      '--interactive-accent': 'none',
      '--text-on-accent': 'url(https://example.com/on-accent.png)',
      '--color-red': 'var(--color-base-30)'
    }
    const built = obsidianIr(scraped, { name: 'Scraped', sourcePath: PATH, variantClass: 'dark' })

    expect(built.ok).toBe(false)
    if (built.ok) throw new Error('unreachable: asserted above')
    expect(built.reason).toBe(
      'obsidian:Scraped: canvas, border, text are unresolved (no usable --background-secondary, ' +
        '--background-modifier-border, --text-normal)'
    )
  })
})

// --- D4: the three rungs, and which of them can reject a theme ----------------

describe('D4 — the role ladder is three rungs, and only a required role rejects', () => {
  it('rescues a theme that declares no canonical role at all, on Obsidian’s own ramp', () => {
    // Things, measured: only `--color-base-*`, `--text-muted`, `--text-faint` and
    // `--color-accent` are declared — 2 of 9 roles under §2.6's canonical list
    // alone, 9 of 9 on the third rung.
    const ramp: ObsidianReads = {
      '--color-base-00': '#ffffff',
      '--color-base-10': '#fafafa',
      '--color-base-20': '#f0f0f0',
      '--color-base-30': '#e0e0e0',
      '--color-base-100': '#1a1a1a',
      '--text-muted': '#5a5a5a',
      '--text-faint': '#8a8a8a',
      '--color-accent': '#e93147'
    }
    const ir = mustIr(ramp, 'dark', 'Things')

    expect(ir.bg).toBe('#ffffff')
    expect(ir.bg2).toBe('#fafafa')
    expect(ir.bg3).toBe('#f0f0f0')
    expect(ir.border).toBe('#e0e0e0')
    expect(ir.fg).toBe('#1a1a1a')
    expect(ir.muted).toBe('#5a5a5a')
    expect(ir.accent_hint).toBe('#e93147')
    // `on_acc` resolves on the ramp too (`--color-base-20` is its last rung), so
    // the field is present rather than omitted.
    expect(ir.on_acc_hint).toBe('#f0f0f0')

    // The variant is the canvas's own lightness, not the class it was read under:
    // this palette is white, so it is light even though it was read under
    // `theme-dark` — and that disagreement is disclosed rather than swallowed.
    expect(ir.variant).toBe('light')
    expect(ir.notes).toEqual([
      'red, orange, yellow, green, cyan, blue, purple, brown accents fell back to the muted tone' +
        ' (red, orange, yellow, green are required by the derivation)',
      'resolved under .theme-dark, whose canvas is light'
    ])

    // The rung is what rescues it: without `--color-base-*` the *same* theme has
    // no canvas, and the rejection names every required role (the §7.2 mutation).
    const crippled: ObsidianReads = { ...ramp }
    delete crippled['--color-base-00']
    const built = obsidianIr(crippled, { name: 'Things', sourcePath: PATH, variantClass: 'dark' })
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error('unreachable: asserted above')
    expect(built.reason).toContain('canvas')
    expect(built.reason).toContain('--background-secondary')
  })

  it('names EVERY unresolved required role and the variable its ladder wanted', () => {
    const built = obsidianIr(
      { '--background-primary': '#101010', '--interactive-accent': '#d4a24e' },
      { name: 'Empty', sourcePath: PATH, variantClass: 'dark' }
    )
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error('unreachable: asserted above')
    // Every one of the three, in ladder order — a message that named only the
    // first would send the user round the loop again (AC6.4's shape).
    expect(built.reason).toBe(
      'obsidian:Empty: canvas, border, text are unresolved (no usable --background-secondary, ' +
        '--background-modifier-border, --text-normal)'
    )
  })

  it('names the declared-but-unusable variable, not the rung two steps down', () => {
    // `--text-normal` is *present* but not a colour (AC6.4's own input). The
    // variable to blame is the one the theme declared: naming the halcyon rung
    // would send the user looking for a variable their theme should not have.
    const built = obsidianIr(
      { '--text-normal': 'none', '--background-secondary': '#101010' },
      { name: 'Odd', sourcePath: PATH, variantClass: 'dark' }
    )
    expect(built.ok).toBe(false)
    if (built.ok) throw new Error('unreachable: asserted above')
    expect(built.reason).toBe(
      'obsidian:Odd: border, text are unresolved (no usable --background-modifier-border, ' +
        '--text-normal)'
    )
  })

  it('omits an unresolved optional role rather than substituting a colour it never named', () => {
    const bare: ObsidianReads = {
      '--background-secondary': '#0f1117',
      '--background-modifier-border': '#262a38',
      '--text-normal': '#e6e6e6',
      '--color-red': '#e06c75',
      '--color-orange': '#e5a05a',
      '--color-yellow': '#d4b106',
      '--color-green': '#98c379'
    }
    const ir = mustIr(bare, 'dark', 'Bare')

    // Absent, not defaulted: a substituted surface would be a colour the theme
    // never declared (D3's rule, applied to the roles with no canonical name).
    expect('bg2' in ir).toBe(false)
    expect('bg3' in ir).toBe(false)
    expect('muted' in ir).toBe(false)
    expect('on_acc_hint' in ir).toBe(false)
    expect(ir.notes).toEqual([
      'panel unresolved — omitted (no usable --background-primary, --halcyon-base-blue-02, --color-base-10)',
      'raised unresolved — omitted (no usable --background-primary-alt, --halcyon-base-blue-03, --color-base-20)',
      'muted unresolved — omitted (no usable --text-muted, --halcyon-base-grey-dark, --color-base-70, --color-base-60, --text-faint)',
      'on_acc unresolved — omitted (no usable --text-on-accent, --halcyon-base-blue-03, --color-base-20, --color-base-10)',
      'cyan, blue, purple, brown accents fell back to the fg tone'
    ])
  })

  it('falls a required accent back to the theme’s own muted tone, and says which did', () => {
    // Blue Topaz and Obsidianite measured 0 of 8 accents: they declare no
    // `--color-*` at all, and rejecting them on the four required slots would
    // leave the app unable to import two of the six themes installed here.
    const noAccents: ObsidianReads = { ...CANONICAL }
    for (const rungs of Object.values(OBSIDIAN_ACCENT_LADDER))
      for (const name of rungs) delete noAccents[name]

    const ir = mustIr(noAccents, 'dark', 'NoAccents')

    expect(ir.accents.red).toBe('#9aa0b0')
    expect(ir.accents.orange).toBe('#9aa0b0')
    expect(ir.accents.yellow).toBe('#9aa0b0')
    expect(ir.accents.green).toBe('#9aa0b0')
    expect(ir.accents.brown).toBe('#9aa0b0')
    expect(ir.notes).toEqual([
      'red, orange, yellow, green, cyan, blue, purple, brown accents fell back to the muted tone' +
        ' (red, orange, yellow, green are required by the derivation)'
    ])
    // The accent *role* still resolved (`--interactive-accent` is a role, not an
    // accent slot), so the hint is the theme's own declared accent.
    expect(ir.accent_hint).toBe('#d4a24e')

    // With the accent role gone too, the hint becomes the value the derivation
    // itself reaches for — the orange slot (`derive.ts:314-321`) — which here is
    // the same muted tone every accent fell back to, because this theme declares
    // no colour at all. The hint is a *slot's* value rather than a synthesised
    // hue; nothing here invents a colour the theme did not supply.
    const noRole: ObsidianReads = { ...noAccents }
    delete noRole['--interactive-accent']
    expect(mustIr(noRole, 'dark', 'NoAccents').accent_hint).toBe('#9aa0b0')
  })
})

// --- D3: the colour normalizer, and what it refuses ---------------------------

describe('D3 — normalizeColour accepts the forms Chromium hands back and nothing else', () => {
  it('reads every accepted form to lowercase #rrggbb', () => {
    for (const [raw, hex] of [
      ['#171c28', '#171c28'],
      ['#FFF', '#ffffff'],
      ['#8695b7', '#8695b7'],
      ['rgb(22, 22, 30)', '#16161e'],
      ['rgb(22 22 30)', '#16161e'],
      ['rgb(100%, 0%, 0%)', '#ff0000'],
      ['rgba(40, 45, 55, 0.65)', '#282d37'],
      ['color(srgb 0.149 0.186 0.264)', '#262f43'],
      ['color(srgb 0 0 0)', '#000000']
    ] as const) {
      expect({ raw, hex: normalizeColour(raw)?.hex }).toEqual({ raw, hex })
    }
  })

  it('drops alpha and reports it, but only when there was an alpha to lose', () => {
    expect(normalizeColour('#8695b799')).toEqual({ hex: '#8695b7', droppedAlpha: true })
    expect(normalizeColour('#e6e6e6ff')).toEqual({ hex: '#e6e6e6', droppedAlpha: false })
    expect(normalizeColour('rgba(40, 45, 55, 0.65)')).toEqual({
      hex: '#282d37',
      droppedAlpha: true
    })
    expect(normalizeColour('color(srgb 0 0 0 / 0.5)')).toEqual({
      hex: '#000000',
      droppedAlpha: true
    })
  })

  it('refuses everything that is not a resolvable colour', () => {
    // Which is the whole contract: a payload that can only be a hex colour cannot
    // carry CSS, a URL or a selector (AC6.3), and a value that still *looks*
    // computed is one the resolver did not manage to resolve (D3).
    for (const raw of [
      '',
      '   ',
      'none',
      'transparent',
      'url(https://example.com/beacon.png)',
      'url(#gradient)',
      'hsl(220, 12%, calc(18% - 2%))',
      'color-mix( in hsl, #1d2433, #2f3b54 )',
      'var(--missing)',
      'var(--color-base-00)',
      '#12345',
      '#1234567',
      'rgb(1, 2)',
      'rgb(1, 2, 3, 4, 5)',
      'rgb(a, b, c)',
      'color(display-p3 1 0 0)',
      '#gggggg'
    ]) {
      expect({ raw, value: normalizeColour(raw) }).toEqual({ raw, value: null })
    }
  })

  it('names every role it dropped an alpha for', () => {
    const ir = mustIr(
      { ...CANONICAL, '--background-modifier-border': '#262a38cc', '--text-faint': '#6b728099' },
      'dark'
    )
    expect(ir.border).toBe('#262a38')
    expect(ir.notes).toEqual(['alpha dropped for border, faint — surfaces are opaque'])
  })
})

// --- D5: the variant is derived, and a second entry has to earn its place -----

describe('D5 — the variant comes from the canvas, and the light entry has to differ', () => {
  it('labels a read by its own canvas lightness, not by the class it was read under', () => {
    expect(variantFromCanvas('#0f1117')).toBe('dark')
    expect(variantFromCanvas('#f7f7f7')).toBe('light')
    // Dracula + LYT measured exactly this shape: the `theme-light` class resolves
    // to a dark palette, so the class is a probe and nothing more.
    expect(mustIr(CANONICAL, 'light').variant).toBe('dark')
    expect(mustIr(CANONICAL_LIGHT, 'dark').variant).toBe('light')
  })

  it('keeps a second entry only when the light read resolved to the other variant', () => {
    const dark = mustIr(CANONICAL, 'dark')
    const light = mustIr(CANONICAL_LIGHT, 'light')
    expect(resolvedEntries(dark, light).map((entry) => entry.variant)).toEqual(['dark', 'light'])

    // The measured collapse: the light *class* answers a dark canvas, so the two
    // reads are one palette and the file has one entry.
    expect(resolvedEntries(dark, mustIr(CANONICAL, 'light')).map((e) => e.variant)).toEqual([
      'dark'
    ])
    // A dark-only theme's light read is entirely empty: it never becomes an IR,
    // so it cannot become an entry.
    expect(resolvedEntries(dark, null).map((entry) => entry.variant)).toEqual(['dark'])
  })
})

// --- AC6.3: nothing but hex colours crosses back ------------------------------

describe('AC6.3 — the resolve result can only carry hex colours', () => {
  it('serializes to values with no CSS, no URL, no at-rule and no non-hex #', () => {
    const ir = mustIr(
      {
        ...CANONICAL,
        '--background-modifier-border': '#262a38cc',
        '--interactive-accent': 'url(https://example.com/track.css)',
        '--color-red': 'var(--color-base-30)'
      },
      'light',
      'Adversarial'
    )
    const payload = JSON.stringify(stringsIn(ir))

    expect(payload).not.toContain('{')
    expect(payload).not.toContain('url(')
    expect(payload).not.toContain('@')
    expect(payload).not.toMatch(/#(?![0-9a-f])/)
    // And every colour-bearing field is a lowercase #rrggbb — the contract the
    // renderer's CSS-variable write depends on.
    for (const hex of [
      ir.bg,
      ir.bg2,
      ir.bg3,
      ir.border,
      ir.fg,
      ir.fg_bright,
      ir.accent_hint,
      ...Object.values(ir.accents)
    ]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    }
    // Non-vacuity: the payload walker really does reach the values it is judging.
    expect(stringsIn(ir)).toContain(ir.bg)
    expect(stringsIn(ir)).toContain(ir.notes[0])
  })
})

// --- AC6.5, the half a unit test can decide -----------------------------------

describe('AC6.5 — the resolver window’s construction is a value', () => {
  it('has no preload, no Node, a sandbox and a fixed partition', () => {
    const options = resolverWindowOptions()
    expect(options).toEqual({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: 'musaeum-theme-resolver'
      }
    })
    // Named separately because it is the escape surface the criterion is about:
    // absent, not `false` — a `preload` key with a path is the mutation AC6.5
    // fails on, and `toEqual` would not notice `preload: undefined`.
    expect(Object.keys(options.webPreferences)).not.toContain('preload')
  })

  it('cancels http(s) and only http(s), so the data document still loads', () => {
    // An unfiltered cancel-all cancels the `data:` document itself, which is the
    // first request the listener sees — measured: `ERR_BLOCKED_BY_CLIENT` and
    // nothing resolves at all.
    expect(resolverRuleFilter()).toEqual({ urls: ['*://*/*'] })
  })
})

// --- D6/D7: the file name, the folder, and the two doors ----------------------

describe('D6/D7 — a .css is a folder, and the file’s name is the format', () => {
  it('names the theme after its folder, or refuses a path that has none', () => {
    expect(OBSIDIAN_THEME_FILE).toBe('theme.css')
    expect(themeFolderName('/vault/.obsidian/themes/Cool Theme/theme.css')).toBe('Cool Theme')
    expect(themeFolderName('themes/halcyon/theme.css')).toBe('halcyon')
    expect(themeFolderName('/theme.css')).toBeNull()
    expect(themeFolderName('theme.css')).toBeNull()
    expect(themeFolderName('')).toBeNull()
  })

  it('gives .css its own refusal in the pure text reader, naming the async door', () => {
    // The synchronous reader can never be the one that reads a stylesheet, and a
    // caller must not read "unsupported theme file type" and conclude the
    // extension is not a provider at all (D6).
    expect(loadThemeText('theme.css', ':root { --x: #fff; }')).toEqual({
      ok: false,
      reason: 'Unsupported theme file type: .css — an Obsidian theme resolves through its folder'
    })
    // The other extensions' refusals are untouched (`parse.test.ts` pins them).
    expect(loadThemeText('palette.txt', 'notes')).toEqual({
      ok: false,
      reason: 'Unsupported theme file type: .txt — expected .yaml, .yml or .itermcolors'
    })
  })

  it('routes a .css through the injected resolver and everything else through the disk', async () => {
    const ir = mustIr(CANONICAL, 'dark')
    const seen: string[] = []
    const loaded = await loadThemeFileAsync('/themes/halcyon/theme.css', async (path) => {
      seen.push(path)
      return { ok: true, ir }
    })

    expect(seen).toEqual(['/themes/halcyon/theme.css'])
    expect(loaded).toEqual({ ok: true, ir })

    // A non-`.css` never reaches the resolver — which is what keeps every yaml
    // and iTerm2 case electron-free (the lazy `await import(...)`).
    const missing = '/no/such/palette.yaml'
    const fromDisk = await loadThemeFileAsync(missing, async () => {
      throw new Error('the resolver must not be asked for a .yaml')
    })
    expect(fromDisk.ok).toBe(false)
    if (fromDisk.ok) throw new Error('unreachable: asserted above')
    expect(fromDisk.reason).toContain(missing)
  })
})
