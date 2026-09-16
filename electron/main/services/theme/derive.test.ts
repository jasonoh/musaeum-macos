import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { AccentSlot, DerivedTokens, DeriveResult, InkStep, ThemeIr } from '@shared/theme.types'
import { contrast, hexToRgb, oklabToSrgb, rgbToHex } from './color'
import { base16ToIr, deriveTheme, loadThemeFile, loadThemeText, parseBase16 } from './index'
// Imported from the engine's *front door*, not from `@shared/theme.types`: the
// compile-time half of the case below asserts that a caller reaching the engine gets
// the discriminated failure shapes (`npm run typecheck` fails if the barrel stops
// exporting either), and not the pre-discriminant `FloorFailure`.
import type { DeriveFailure, FloorReason } from './index'

/**
 * `derive.py`'s numbers, reproduced.
 *
 * Every expectation in this file is a literal taken from the prototype's own
 * output for the same palette — never read out of `/tmp`, never re-derived by a
 * second implementation. A literal that stops matching means the port drifted
 * from the prototype, which is the only thing this suite is about.
 */

const BUILTIN = join(process.cwd(), 'electron', 'main', 'services', 'theme', 'builtin')
const ITERM_FIXTURES = join(process.cwd(), 'test', 'fixtures', 'theme')

type Derived = Extract<DeriveResult, { ok: true }>

/** Load a provider file and derive it, failing the test rather than the helper. */
function deriveFixture(path: string): Derived {
  const loaded = loadThemeFile(path)
  if (!loaded.ok) throw new Error(`${path} did not load: ${loaded.reason}`)
  const result = deriveTheme(loaded.ir)
  if (!result.ok) {
    const { reason } = result
    throw new Error(
      `${path} was rejected: ` +
        (reason.kind === 'floor'
          ? `${reason.role} ${reason.ratio} < ${reason.floor} (${reason.metric})`
          : `malformed ${reason.role}: ${reason.detail}`)
    )
  }
  return result
}

/** Audit ratios are asserted to one decimal place, as AC2.1 asks. */
const at1dp = (ratio: number): number => Math.round(ratio * 10) / 10

/**
 * Formats a rejection from its discriminant alone — the shape slice 4 needs when it
 * writes a per-row reason, and the reason the front door exports `DeriveFailure`,
 * `FloorReason` and `MalformedReason` instead of the pre-discriminant `FloorFailure`
 * (which has no `kind` to narrow on, and reading `.ratio` off it is exactly what the
 * discriminant was added to prevent).
 */
function describeFailure(reason: DeriveFailure): string {
  return reason.kind === 'floor'
    ? `${reason.role} ${reason.ratio} < ${reason.floor} (${reason.metric})`
    : `${reason.role}: ${reason.detail}`
}

/**
 * One colour in all eight accent slots: the ramp cases are about the ramps, not the
 * slots. Module scope because two blocks read it (D3's witnesses and A20's sweep).
 */
function allAccents(hex: string): Record<AccentSlot, string> {
  return {
    red: hex,
    orange: hex,
    yellow: hex,
    green: hex,
    cyan: hex,
    blue: hex,
    purple: hex,
    brown: hex
  }
}

interface Expected {
  tokens: DerivedTokens
  /** `[name, ratio to 1dp, floor]` for every audit row, in the prototype's order. */
  audits: [string, number, number][]
  adjusted: string[]
  notes: string[]
}

function expectDerived(result: Derived, expected: Expected): void {
  expect(result.tokens).toEqual(expected.tokens)
  expect(result.audits.map((a) => [a.name, at1dp(a.ratio), a.floor])).toEqual(expected.audits)
  expect(result.adjusted).toEqual(expected.adjusted)
  expect(result.notes).toEqual(expected.notes)
}

const GRUVBOX_DARK_HARD: Expected = {
  tokens: {
    ink: {
      '950': '#1d2021',
      '900': '#242626',
      '850': '#2b2b2b',
      '800': '#333230',
      '700': '#3c3936',
      '600': '#47433f',
      '500': '#57504a'
    },
    parchment: {
      parchment: '#d5c4a1',
      parchment_dim: '#817a68',
      parchment_faint: '#635f53'
    },
    gold: { '300': '#f49752', '400': '#fe8019', '500': '#db7225', '600': '#ab5f2b' },
    on_acc: '#1d2021',
    scrim: '#0b0d0d',
    status: {
      danger: { '400': '#ff513b', '500': '#fb4934', '600': '#b30000', on: '#1d2021' },
      ok: { '400': '#b8bb26', '500': '#b8bb26', '600': '#737300', on: '#1d2021' },
      warn: { '400': '#fabd2f', '500': '#fabd2f', '600': '#a86f00', on: '#1d2021' }
    },
    shadow: 0.55,
    dark: true
  },
  audits: [
    ['text on canvas', 9.6, 4.5],
    ['dim text on panel', 3.6, 3.5],
    ['faint text on panel', 2.4, 2.2],
    ['accent on panel', 6.0, 3.0],
    ['accent on canvas', 6.5, 3.0],
    ['on-accent / filled', 5.0, 4.0],
    ['scrim darkens (abs lum<0.06)', 15.6, 1.0],
    ['danger-400 on panel (text)', 4.7, 4.5],
    ['danger-500 vs canvas', 4.8, 3.0],
    ['text on danger-500', 4.8, 4.0],
    ['ok-400 on panel (text)', 7.4, 4.5],
    ['ok-500 vs canvas', 7.9, 3.0],
    ['text on ok-500', 7.9, 4.0],
    ['warn-400 on panel (text)', 9.0, 4.5],
    ['warn-500 vs canvas', 9.7, 3.0],
    ['text on warn-500', 9.7, 4.0]
  ],
  adjusted: ['parchment_faint raised to meet 2.2:1'],
  notes: []
}

const NORD: Expected = {
  tokens: {
    ink: {
      '950': '#2e3440',
      '900': '#313744',
      '850': '#343a48',
      '800': '#373e4d',
      '700': '#3b4252',
      '600': '#3f4858',
      '500': '#464f62'
    },
    parchment: {
      parchment: '#e5e9f0',
      parchment_dim: '#9298a1',
      parchment_faint: '#6e737e'
    },
    gold: { '300': '#d8a596', '400': '#d08770', '500': '#c08c7e', '600': '#966a61' },
    on_acc: '#2e3440',
    scrim: '#151920',
    status: {
      danger: { '400': '#e9868e', '500': '#bf616a', '600': '#832b38', on: '#ffffff' },
      ok: { '400': '#a3be8c', '500': '#a3be8c', '600': '#5f7748', on: '#2e3440' },
      warn: { '400': '#ebcb8b', '500': '#ebcb8b', '600': '#997b3c', on: '#2e3440' }
    },
    shadow: 0.55,
    dark: true
  },
  audits: [
    ['text on canvas', 10.3, 4.5],
    ['dim text on panel', 4.1, 3.5],
    ['faint text on panel', 2.5, 2.2],
    ['accent on panel', 4.2, 3.0],
    ['accent on canvas', 4.4, 3.0],
    ['on-accent / filled', 4.3, 4.0],
    ['scrim darkens (abs lum<0.06)', 6.4, 1.0],
    ['danger-400 on panel (text)', 4.7, 4.5],
    ['danger-500 vs canvas', 3.1, 3.0],
    ['text on danger-500', 4.1, 4.0],
    ['ok-400 on panel (text)', 5.9, 4.5],
    ['ok-500 vs canvas', 6.1, 3.0],
    ['text on ok-500', 6.1, 4.0],
    ['warn-400 on panel (text)', 7.6, 4.5],
    ['warn-500 vs canvas', 8.0, 3.0],
    ['text on warn-500', 8.0, 4.0]
  ],
  adjusted: ['filled accent deepened to carry 4:1 text'],
  notes: []
}

const SOLARIZED_DARK: Expected = {
  tokens: {
    ink: {
      '950': '#002b36',
      '900': '#0a333e',
      '850': '#133a45',
      '800': '#1e434d',
      '700': '#2a4d56',
      '600': '#3b5963',
      '500': '#516b74'
    },
    parchment: {
      parchment: '#93a1a1',
      parchment_dim: '#738689',
      parchment_faint: '#50696e'
    },
    gold: { '300': '#bf6b4c', '400': '#c95225', '500': '#a77b6a', '600': '#894730' },
    on_acc: '#002b36',
    scrim: '#00131a',
    status: {
      danger: { '400': '#ff6157', '500': '#dc322f', '600': '#9d0000', on: '#ffffff' },
      ok: { '400': '#8ba014', '500': '#859900', '600': '#4f5f00', on: '#002b36' },
      warn: { '400': '#bc8f13', '500': '#b58900', '600': '#784f00', on: '#002b36' }
    },
    shadow: 0.55,
    dark: true
  },
  audits: [
    ['text on canvas', 5.6, 4.5],
    ['dim text on panel', 3.5, 3.5],
    ['faint text on panel', 2.3, 2.2],
    ['accent on panel', 3.0, 3.0],
    ['accent on canvas', 3.4, 3.0],
    ['on-accent / filled', 4.1, 4.0],
    ['scrim darkens (abs lum<0.06)', 11.0, 1.0],
    ['danger-400 on panel (text)', 4.6, 4.5],
    ['danger-500 vs canvas', 3.2, 3.0],
    ['text on danger-500', 4.6, 4.0],
    ['ok-400 on panel (text)', 4.6, 4.5],
    ['ok-500 vs canvas', 4.7, 3.0],
    ['text on ok-500', 4.7, 4.0],
    ['warn-400 on panel (text)', 4.6, 4.5],
    ['warn-500 vs canvas', 4.7, 3.0],
    ['text on warn-500', 4.7, 4.0]
  ],
  // The prototype needed all four walks on solarized-dark: its dim and faint stops
  // miss their floors, its accent misses 3:1 as text, and its fill cannot carry 4:1.
  adjusted: [
    'parchment_dim raised to meet 3.5:1',
    'parchment_faint raised to meet 2.2:1',
    'accent nudged toward fg for 3:1 on panels',
    'filled accent deepened to carry 4:1 text'
  ],
  notes: []
}

const CATPPUCCIN_LATTE: Expected = {
  tokens: {
    ink: {
      '950': '#eff1f5',
      '900': '#eaecf1',
      '850': '#e5e8ed',
      '800': '#e0e2e9',
      '700': '#dadce4',
      '600': '#d1d5dd',
      '500': '#c6cad4'
    },
    parchment: {
      parchment: '#4c4f69',
      parchment_dim: '#787b90',
      parchment_faint: '#9c9faf'
    },
    gold: { '300': '#c86344', '400': '#d6643b', '500': '#ffa07c', '600': '#ff9a72' },
    on_acc: '#4c4f69',
    scrim: '#272837',
    status: {
      danger: { '400': '#d20f39', '500': '#d20f39', '600': '#960005', on: '#ffffff' },
      ok: { '400': '#027600', '500': '#388f25', '600': '#006600', on: '#ffffff' },
      warn: { '400': '#a05400', '500': '#9f6411', '600': '#984d00', on: '#ffffff' }
    },
    shadow: 0.16,
    dark: false
  },
  audits: [
    ['text on canvas', 7.1, 4.5],
    ['dim text on panel', 3.5, 3.5],
    ['faint text on panel', 2.2, 2.2],
    ['accent on panel', 3.1, 3.0],
    ['accent on canvas', 3.2, 3.0],
    ['on-accent / filled', 4.0, 4.0],
    ['scrim darkens (abs lum<0.06)', 2.7, 1.0],
    ['danger-400 on panel (text)', 4.6, 4.5],
    ['danger-500 vs canvas', 4.8, 3.0],
    ['text on danger-500', 5.4, 4.0],
    ['ok-400 on panel (text)', 5.0, 4.5],
    ['ok-500 vs canvas', 3.6, 3.0],
    ['text on ok-500', 4.1, 4.0],
    ['warn-400 on panel (text)', 4.7, 4.5],
    ['warn-500 vs canvas', 4.3, 3.0],
    ['text on warn-500', 4.9, 4.0]
  ],
  adjusted: [
    'parchment_dim raised to meet 3.5:1',
    'parchment_faint raised to meet 2.2:1',
    'accent nudged toward fg for 3:1 on panels',
    'filled accent deepened to carry 4:1 text'
  ],
  notes: []
}

const ITERM_GRUVBOX: Expected = {
  tokens: {
    ink: {
      '950': '#1d2021',
      '900': '#2b2c2b',
      '850': '#373734',
      '800': '#47443f',
      '700': '#57534b',
      '600': '#6e665a',
      '500': '#8c8170'
    },
    parchment: {
      parchment: '#ebdbb2',
      parchment_dim: '#8d8671',
      parchment_faint: '#636054'
    },
    gold: { '300': '#f6c764', '400': '#fabd2f', '500': '#d7a534', '600': '#a88437' },
    on_acc: '#1d2021',
    scrim: '#0b0d0d',
    status: {
      danger: { '400': '#ff5a4b', '500': '#d73228', '600': '#920000', on: '#ffffff' },
      ok: { '400': '#98971a', '500': '#98971a', '600': '#5f5c00', on: '#1d2021' },
      warn: { '400': '#d79921', '500': '#d79921', '600': '#915700', on: '#1d2021' }
    },
    shadow: 0.55,
    dark: true
  },
  audits: [
    ['text on canvas', 12.0, 4.5],
    ['dim text on panel', 3.9, 3.5],
    ['faint text on panel', 2.2, 2.2],
    ['accent on panel', 8.3, 3.0],
    ['accent on canvas', 9.7, 3.0],
    ['on-accent / filled', 7.3, 4.0],
    ['scrim darkens (abs lum<0.06)', 15.6, 1.0],
    ['danger-400 on panel (text)', 4.6, 4.5],
    ['danger-500 vs canvas', 3.4, 3.0],
    ['text on danger-500', 4.8, 4.0],
    ['ok-400 on panel (text)', 4.5, 4.5],
    ['ok-500 vs canvas', 5.3, 3.0],
    ['text on ok-500', 5.3, 4.0],
    ['warn-400 on panel (text)', 5.7, 4.5],
    ['warn-500 vs canvas', 6.6, 3.0],
    ['text on warn-500', 6.6, 4.0]
  ],
  adjusted: [],
  notes: ['ramp inferred from 3 greys; no base01-03 in source']
}

const ITERM_NORD: Expected = {
  tokens: {
    ink: {
      '950': '#2e3440',
      '900': '#323844',
      '850': '#363c48',
      '800': '#3b414d',
      '700': '#404652',
      '600': '#474d59',
      '500': '#505662'
    },
    parchment: {
      parchment: '#d8dee9',
      parchment_dim: '#8b929e',
      parchment_faint: '#69707c'
    },
    gold: { '300': '#e6d1a9', '400': '#ebcb8b', '500': '#ceb481', '600': '#a69473' },
    on_acc: '#2e3440',
    scrim: '#151920',
    status: {
      danger: { '400': '#e9868e', '500': '#bf616a', '600': '#832b38', on: '#ffffff' },
      ok: { '400': '#a3be8c', '500': '#a3be8c', '600': '#5f7748', on: '#2e3440' },
      warn: { '400': '#ebcb8b', '500': '#ebcb8b', '600': '#997b3c', on: '#2e3440' }
    },
    shadow: 0.55,
    dark: true
  },
  audits: [
    ['text on canvas', 9.2, 4.5],
    ['dim text on panel', 3.8, 3.5],
    ['faint text on panel', 2.4, 2.2],
    ['accent on panel', 7.5, 3.0],
    ['accent on canvas', 8.0, 3.0],
    ['on-accent / filled', 6.2, 4.0],
    ['scrim darkens (abs lum<0.06)', 6.4, 1.0],
    ['danger-400 on panel (text)', 4.6, 4.5],
    ['danger-500 vs canvas', 3.1, 3.0],
    ['text on danger-500', 4.1, 4.0],
    ['ok-400 on panel (text)', 5.8, 4.5],
    ['ok-500 vs canvas', 6.1, 3.0],
    ['text on ok-500', 6.1, 4.0],
    ['warn-400 on panel (text)', 7.5, 4.5],
    ['warn-500 vs canvas', 8.0, 3.0],
    ['text on warn-500', 8.0, 4.0]
  ],
  adjusted: [],
  notes: ['ramp inferred from 3 greys; no base01-03 in source']
}

/**
 * AC2.1. The four base16 fixtures and the two iTerm fixtures, every derived value
 * and every audit ratio. Note the prototype's output — not the spec's prose — is
 * the expectation: the spec cites "nord parchment = #d8dee9", which is the iTerm
 * fixture's foreground; base16 nord.yaml's base05 is #e5e9f0, and that is what the
 * base16 row must derive.
 */
describe('AC2.1 — the prototype’s numbers reproduce', () => {
  const cases: [string, Expected][] = [
    [join(BUILTIN, 'gruvbox-dark-hard.yaml'), GRUVBOX_DARK_HARD],
    [join(BUILTIN, 'nord.yaml'), NORD],
    [join(BUILTIN, 'solarized-dark.yaml'), SOLARIZED_DARK],
    [join(BUILTIN, 'catppuccin-latte.yaml'), CATPPUCCIN_LATTE],
    [join(ITERM_FIXTURES, 'gruvbox.itermcolors'), ITERM_GRUVBOX],
    [join(ITERM_FIXTURES, 'nord.itermcolors'), ITERM_NORD]
  ]

  it.each(cases)('reproduces %s', (path, expected) => {
    expectDerived(deriveFixture(path), expected)
  })

  it('agrees with the prototype to full precision, not just to one decimal', () => {
    const { audits } = deriveFixture(join(BUILTIN, 'gruvbox-dark-hard.yaml'))
    const ratio = (name: string): number => audits.find((a) => a.name === name)?.ratio ?? -1
    expect(ratio('text on canvas')).toBeCloseTo(9.556342448321281, 9)
    expect(ratio('dim text on panel')).toBeCloseTo(3.562502987794441, 9)
    expect(ratio('faint text on panel')).toBeCloseTo(2.385312191823251, 9)
    expect(ratio('accent on panel')).toBeCloseTo(6.024915890482715, 9)
    expect(ratio('accent on canvas')).toBeCloseTo(6.4926767044432045, 9)
    expect(ratio('on-accent / filled')).toBeCloseTo(5.032490212635409, 9)
  })

  it('keeps the surface ladder on the source’s axis, which linear-vs-Oklab decides', () => {
    // The mutation AC2.1 names: a single Oklab mix for the ladder moves every stop
    // between 900 and 500. 950 is the canvas itself, so it is the one that cannot.
    const { tokens } = deriveFixture(join(BUILTIN, 'gruvbox-dark-hard.yaml'))
    const ink: Record<InkStep, string> = tokens.ink
    expect(ink['950']).toBe('#1d2021')
    expect(ink['900']).toBe('#242626')
    expect(ink['500']).toBe('#57504a')
  })
})

/**
 * A palette whose canvas, text and accent all sit at the same luminance: AC2.2's
 * fixture, and the base for the malformed-IR cases. Module scope because two
 * describe blocks read it.
 */
const GREY = '#808080'
const METRONOME: ThemeIr = {
  name: 'metronome',
  author: '',
  variant: 'dark',
  source: 'native',
  bg: GREY,
  bg2: GREY,
  bg3: GREY,
  border: GREY,
  muted: GREY,
  fg: GREY,
  fg_bright: GREY,
  accents: {
    red: GREY,
    orange: GREY,
    yellow: GREY,
    green: GREY,
    cyan: GREY,
    blue: GREY,
    purple: GREY,
    brown: GREY
  },
  accent_hint: GREY,
  notes: []
}

/**
 * AC2.2. A palette whose canvas and text sit at the same luminance must be
 * rejected, not returned with an audit row that reads FAIL.
 */
describe('AC2.2 — floors are enforced, and a failure is a rejection', () => {
  it('rejects a canvas and a text colour at the same luminance', () => {
    const result = deriveTheme(METRONOME)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    // The criterion names `{ role, ratio, floor }`; the repair round added the
    // discriminant (`kind`) and the scale (`metric`) to the failure arm. Those
    // fields are the criterion's own, not replacements for them.
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'parchment',
      ratio: 1,
      floor: 4.5,
      metric: 'contrast'
    })
    // The failed walk is still recorded, and the result is a value — nothing threw.
    expect(result.adjusted).toEqual(['parchment raised to meet 4.5:1'])
    expect(result.notes).toEqual([])
  })

  it('still holds the floor when the loader is what found the palette', () => {
    // This replaces a case that claimed loader coverage it did not have: it called
    // `deriveTheme` directly and re-asserted the metronome, and its shallow copy
    // aliased `METRONOME.notes`. A loader path *can* carry a floor failure — both
    // adapters validate the file's shape, but neither can know whether the palette
    // it read holds its contrast floors — so this takes a real scheme and moves one
    // field the derivation reads. base03 is `border`; greyed out, the `warn` text
    // step lands 0.009 short of 4.5:1 on the panel it is read against.
    const text = readFileSync(join(BUILTIN, 'solarized-dark.yaml'), 'utf8')
    const crippled = text.replace(/^\s*base03:.*$/m, '  base03: "#808080"')
    expect(crippled).not.toBe(text)

    const loaded = loadThemeText('solarized-dark.yaml', crippled)
    if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`)
    const result = deriveTheme(loaded.ir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'warn-400',
      ratio: 4.4911388886115615,
      floor: 4.5,
      metric: 'contrast'
    })
  })

  it('keeps a palette that only nudges, and records the adjustment', () => {
    const { tokens, adjusted } = deriveFixture(join(BUILTIN, 'catppuccin-latte.yaml'))
    expect(adjusted).toContain('parchment_dim raised to meet 3.5:1')
    // Raised, not replaced: the stop is still the palette's own ink, dimmed toward
    // its canvas, and it now clears the floor it missed by 0.03:1.
    expect(tokens.parchment.parchment_dim).toBe('#787b90')
    expect(
      contrast(hexToRgb(tokens.parchment.parchment_dim), hexToRgb(tokens.ink['900']))
    ).toBeGreaterThanOrEqual(3.5)
  })
})

/**
 * AC2.3. The two roles no provider supplies, on every palette that has one, and
 * the prototype's own zero-failure claim re-taken in TypeScript over the whole
 * vendored corpus.
 */
describe('AC2.3 — on-accent is never unreadable', () => {
  const ITERM_CORPUS = [
    join(ITERM_FIXTURES, 'gruvbox.itermcolors'),
    join(ITERM_FIXTURES, 'nord.itermcolors')
  ]
  const CORPUS: string[] = [
    join(BUILTIN, 'gruvbox-dark-hard.yaml'),
    join(BUILTIN, 'nord.yaml'),
    join(BUILTIN, 'solarized-dark.yaml'),
    join(BUILTIN, 'catppuccin-latte.yaml'),
    ...ITERM_CORPUS
  ]

  it.each(CORPUS)('holds 4:1 for on-accent and 3:1 for the accent on %s', (path) => {
    const { tokens } = deriveFixture(path)
    const onAccent = contrast(hexToRgb(tokens.on_acc), hexToRgb(tokens.gold['500']))
    const accentOnPanel = contrast(hexToRgb(tokens.gold['400']), hexToRgb(tokens.ink['900']))
    expect(onAccent).toBeGreaterThanOrEqual(4)
    expect(accentOnPanel).toBeGreaterThanOrEqual(3)
  })

  it('derives the whole corpus with every audit meeting its floor', () => {
    const yaml = readdirSync(BUILTIN)
      .filter((f) => f.endsWith('.yaml'))
      .sort()
    // Pinned so a corpus that grows or shrinks is visible rather than absorbed
    expect(yaml).toHaveLength(13)

    const shortfalls: string[] = []
    let audits = 0
    for (const path of [...yaml.map((f) => join(BUILTIN, f)), ...ITERM_CORPUS]) {
      const { audits: rows } = deriveFixture(path)
      audits += rows.length
      for (const row of rows) {
        if (row.ratio < row.floor) {
          shortfalls.push(`${path}: ${row.name} ${row.ratio} < ${row.floor}`)
        }
      }
    }
    expect(shortfalls).toEqual([])
    // 15 palettes × 16 audits: the prototype's own count, re-taken here
    expect(audits).toBe(240)
  })
})

/**
 * D3 — the terminal verification, the one thing this port adds to the prototype:
 * after each of the six bounded floor loops, re-check the floor on the value that
 * actually ships and reject if it is unmet. Each case here is the *witness* for
 * one loop — re-instating the prototype's exit-without-re-checking behaviour on
 * that loop reddens it.
 *
 * The reviewer's measurement, and why this block exists: five of the six loops
 * were decided by nothing. Deleting each one in turn from a copy left the suite
 * green (51/51 at the time), because AC2.2's metronome IR cannot reach the later
 * loops — the text ramp rejects it first. The text ramp itself is decided by AC2.2,
 * the status-`400` loop by the loader case there and by the two cases below, and
 * the other three below.
 *
 * Each case is a *minimal* input — one colour per guard — so a reader can see which
 * floors had to hold for the guard to be reached at all. The `on-accent` case took
 * the longest to find: it is unreachable with neutral colours (measured: 33.5M IRs
 * over the whole grey cube, bg, fg and the accent each drawn from all 256 greys,
 * both variants, border = bg, zero rejections) and only appears once the accent
 * carries chroma.
 */
describe('D3 — the terminal verifications, each with a witness', () => {
  /**
   * The shape these cases fill in: `allAccents` (module scope, shared with A20's
   * sweep) puts one colour in all eight accent slots, and the text clears its own
   * floor against a black canvas, so each case moves only the colours its guard reads.
   */
  const witness = (fields: Partial<ThemeIr>): ThemeIr => ({
    name: 'witness',
    author: '',
    variant: 'dark',
    source: 'native',
    bg: '#000000',
    bg2: '#000000',
    bg3: '#000000',
    border: '#000000',
    muted: '#000000',
    fg: '#7b7b7b',
    fg_bright: '#7b7b7b',
    accents: allAccents('#000000'),
    accent_hint: '#000000',
    notes: [],
    ...fields
  })

  it('rejects an accent that can never climb off its own canvas', () => {
    // `gold-400`'s walk mixes 6% toward fg *from the quantised hex*, 20 times. Six
    // percent of the way from black toward a mid-grey is 0.14 of an 8-bit step, so
    // every iteration quantises back to #000000: the accent never moves, and the
    // token ships at exactly the panel's own luminance.
    const result = deriveTheme(witness({ name: 'gold-400-floor' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'gold-400',
      ratio: 1,
      floor: 3,
      metric: 'contrast'
    })
    // The walk records nothing, because the value it would have recorded is the
    // accent itself: `gold['400'] === rgbToHex(acc)`.
    expect(result.adjusted).toEqual([
      'parchment_dim raised to meet 3.5:1',
      'parchment_faint raised to meet 2.2:1'
    ])
  })

  it('rejects a scrim the quantiser carries back over its floor', () => {
    // The narrowest of the six: this canvas's hue survives the push to black, and
    // the walk leaves the scrim at 0.05999 — its last mix lands under the floor and
    // breaks the loop — but the *shipped* value is `rgbToHex` of it, and the
    // quantised hex measures 0.0608. The prototype returns this theme with its own
    // audit row reading FAIL.
    const result = deriveTheme(
      witness({
        name: 'scrim-floor',
        bg: '#a3bf72',
        bg2: '#a3bf72',
        bg3: '#a3bf72',
        border: '#a3bf72',
        muted: '#101010',
        fg: '#101010',
        fg_bright: '#101010',
        accent_hint: '#fabd2f',
        accents: allAccents('#fabd2f')
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    // `metric: 'luminance'` — the one floor in this file that is not a contrast
    // ratio, so a caller cannot format 0.0608 against 0.06 as if it were 1.0:1
    // against 4.5.
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'scrim',
      ratio: 0.060817871385434256,
      floor: 0.06,
      metric: 'luminance'
    })
    expect(result.adjusted).toContain('scrim deepened to stay a veil in this variant')
  })

  it('rejects a status fill that cannot hold both its floors', () => {
    // base0B feeds `ok`; blacked out, the fill walks its 40 candidate steps and
    // never reaches a combined score of 1.0 (4:1 for its foreground *and* 3:1 off
    // the canvas). Through the loader, so the file-level path is covered too.
    const text = readFileSync(join(BUILTIN, 'gruvbox-dark-hard.yaml'), 'utf8')
    const crippled = text.replace(/^\s*base0B:.*$/m, '  base0B: "#000000"')
    expect(crippled).not.toBe(text)

    const loaded = loadThemeText('gruvbox-dark-hard.yaml', crippled)
    if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`)
    const result = deriveTheme(loaded.ir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'ok-500',
      ratio: 0.4943842163233651,
      floor: 1,
      metric: 'contrast'
    })
    expect(result.adjusted).toContain('ok-500 could not hold both floors')
  })

  it('rejects a status text step that walks the wrong way on a misdeclared variant', () => {
    // The family loop's other half, and the reason the guard reads `variant` at all:
    // the text step is raised on a dark panel and lowered on a light one, so a dark
    // palette declared `light` walks its `danger` step *away* from the panel it is
    // read against. Pinned through the loader because `variant` is the only input
    // that moves here — a file can carry it, and slice 6 can get it wrong.
    const text = readFileSync(join(BUILTIN, 'gruvbox-dark-hard.yaml'), 'utf8')
    const flipped = text.replace(/^\s*variant:.*$/m, 'variant: light')
    expect(flipped).not.toBe(text)

    const loaded = loadThemeText('gruvbox-dark-hard.yaml', flipped)
    if (!loaded.ok) throw new Error(`did not load: ${loaded.reason}`)
    expect(loaded.ir.variant).toBe('light')
    const result = deriveTheme(loaded.ir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'danger-400',
      ratio: 1.3334285843725062,
      floor: 4.5,
      metric: 'contrast'
    })
  })

  it('rejects a chromatic accent fill that cannot carry 4:1 text', () => {
    // The narrowest of the six, and the one a search over *grey* accents cannot
    // find: on a mid-grey canvas the accent ramp deepens `gold-500` all 24 steps
    // without either end reaching 4:1 — the panel and the parchment are 4.55:1
    // apart, which the text ramp has already enforced, so the fill has nowhere left
    // to go. It ships 0.012 short. The walk records the deepening all the same.
    const result = deriveTheme(
      witness({
        name: 'on-accent-floor',
        bg: '#555555',
        bg2: '#555555',
        bg3: '#555555',
        border: '#555555',
        muted: '#cacaca',
        fg: '#cacaca',
        fg_bright: '#cacaca',
        accent_hint: '#ff5100',
        accents: allAccents('#ff5100')
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'on-accent',
      ratio: 3.9877632698586067,
      floor: 4,
      metric: 'contrast'
    })
    expect(result.adjusted).toContain('filled accent deepened to carry 4:1 text')
  })
})

/**
 * A20 — no success may carry an audit row below its own floor, verified as a *sweep*
 * over the assembled table rather than as two more per-site guards: that table is what
 * the picker prints beside the theme it shows as active, so the criterion is about the
 * table, not about which loop happened to produce a row.
 *
 * Why the six D3 guards above cannot decide this on their own, measured: the status
 * fill's guard verifies a combined *score*,
 * `min(max-on / 4.0, max(contrast(fill, canvas), contrast(fill, panel)) / 3.0) >= 1.0`.
 * The separation half is a **max over the canvas and the panel**, so a fill that
 * separates from the panel but not from the canvas passes the guard while the shipped
 * `'<family>-500 vs canvas'` row (floor 3.0) reads FAIL; and `'accent on canvas'` is
 * audited with no walk of its own at all. Both witnesses below are the auditor's,
 * re-measured on this tree: before the sweep, of 300,000 random IRs 40,894 returned
 * `ok: true` and 715 of those carried a row below its floor.
 */
describe('A20 — no success may carry an audit row below its own floor', () => {
  /** The shape every case here fills in: one colour per ramp, so nothing else moves. */
  const irWith = (fields: Partial<ThemeIr>): ThemeIr => ({
    name: 'a20',
    author: '',
    variant: 'dark',
    source: 'native',
    bg: '#000000',
    bg2: '#000000',
    bg3: '#000000',
    border: '#000000',
    muted: '#000000',
    fg: '#808080',
    fg_bright: '#808080',
    accents: allAccents('#808080'),
    accent_hint: '#000000',
    notes: [],
    ...fields
  })

  it('rejects the light witness whose fills clear the panel but not the canvas', () => {
    // Measured on the previous tree: `ok: true` with three rows reading
    // 2.8156685925750247 < 3.0, the shipped `status.danger['500']` (#a6ff6e) separating
    // 2.814978 from the canvas and 3.000928 from the panel — i.e. the score's `max`
    // half satisfied by the panel while the row the table prints is the canvas one.
    const result = deriveTheme(
      irWith({
        name: 'a20-light',
        variant: 'light',
        bg: '#e043e4',
        bg2: '#e043e4',
        bg3: '#e043e4',
        border: '#92903d',
        muted: '#f494a0',
        fg: '#070707',
        fg_bright: '#070707',
        accents: allAccents('#79d23a'),
        accent_hint: '#2c3a0a'
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    // `role` is the audit row's own name: the row is what failed.
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'danger-500 vs canvas',
      ratio: 2.8156685925750247,
      floor: 3,
      metric: 'contrast'
    })
  })

  it('rejects the dark witness whose accent clears the panel but not the canvas', () => {
    // Measured on the previous tree: `ok: true` with `accent on canvas` reading
    // 2.8797674195915004 < 3.0 — the row with no guard behind it at all, since the
    // accent is walked only until it clears `ink-900`.
    const result = deriveTheme(
      irWith({
        name: 'a20-dark',
        variant: 'dark',
        bg: '#307209',
        bg2: '#307209',
        bg3: '#307209',
        border: '#b13057',
        muted: '#f4f4f4',
        fg: '#f4f4f4',
        fg_bright: '#f4f4f4',
        accents: allAccents('#6c0e35'),
        accent_hint: '#6c0e35'
      })
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'floor',
      role: 'accent on canvas',
      ratio: 2.8797674195915004,
      floor: 3,
      metric: 'contrast'
    })
  })

  it('holds over a grid of synthetic palettes, and the grid reaches points only it refuses', () => {
    // The sweep is the general guarantee, so the case that pins it must be able to fail
    // on palettes nobody chose: every combination of these canvases, borders, inks and
    // accents is derived, and every *success* is checked against its own table.
    const CANVASES = ['#e043e4', '#307209', '#f5f0e0', '#101010', '#b4b4b4', '#123456']
    const BORDERS = ['#92903d', '#b13057']
    const INKS = ['#f494a0', '#f4f4f4', '#070707']
    const ACCENTS = ['#79d23a', '#6c0e35', '#ceacb4']

    let successes = 0
    const shortfalls: string[] = []
    const swept: string[] = []
    for (const bg of CANVASES) {
      for (const border of BORDERS) {
        for (const fg of INKS) {
          for (const accent of ACCENTS) {
            const ir = irWith({
              name: `grid ${bg} ${border} ${fg} ${accent}`,
              variant: 'light',
              bg,
              bg2: bg,
              bg3: bg,
              border,
              muted: fg,
              fg,
              fg_bright: fg,
              accents: allAccents(accent),
              accent_hint: accent
            })
            const result = deriveTheme(ir)
            if (!result.ok) {
              // Every per-site guard names a single token (`parchment`, `gold-400`,
              // `on-accent`, `scrim`, `danger-400`, `danger-500`) or a family fill's
              // score; every audit row's own name contains a space. So a rejection whose
              // role contains one is the sweep's, and only the sweep's.
              if (result.reason.role.includes(' ')) swept.push(result.reason.role)
              continue
            }
            successes += 1
            for (const row of result.audits) {
              if (row.ratio < row.floor) {
                shortfalls.push(`${ir.name}: ${row.name} ${row.ratio} < ${row.floor}`)
              }
            }
          }
        }
      }
    }
    expect(shortfalls).toEqual([])
    // Non-vacuity in both directions, measured on the previous tree: the grid reached
    // 31 successes, 3 of which carried three FAIL rows each. Without the first number a
    // grid that rejected everything would pass the assertion above; without the second
    // this case would be green with the sweep deleted, i.e. it would not be a witness.
    expect(successes).toBe(28)
    expect(swept).toHaveLength(3)
    expect(swept.every((role) => role.endsWith(' vs canvas'))).toBe(true)
  })
})

/**
 * `deriveTheme` is total (invariant 12 / D3). It is the only entry point that
 * will ever see an IR this package did not build — slice 6's resolver and slice
 * 3's re-derive both hand it one — and both of its old failure modes were wrong:
 * it threw on a missing field, and it *succeeded* on a value it could not read,
 * returning `ink-950 = #NaNNaN0a` with 16 of 16 audit ratios NaN. Every floor
 * comparison against a NaN is false, so every floor "passed".
 */
describe('the derivation rejects a malformed IR as a value, never a throw', () => {
  /** An IR shaped the way an untrusted caller would build one: fields missing, mistyped. */
  const asIr = (value: unknown): ThemeIr => value as ThemeIr

  it('names the required field that is missing, instead of throwing on it', () => {
    // The reviewer's reproduction: `{ …ir, bg: undefined }` threw
    // `TypeError: Cannot read properties of undefined (reading 'replace')`.
    const result = deriveTheme(asIr({ ...METRONOME, bg: undefined }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'malformed',
      role: 'bg',
      detail: expect.stringContaining('hex colour')
    })
  })

  it('names a missing border, a deleted accent and an emptied accents object', () => {
    const cases: [string, unknown][] = [
      ['border', { ...METRONOME, border: undefined }],
      ['accents.red', { ...METRONOME, accents: { ...METRONOME.accents, red: undefined } }],
      ['accents.red', { ...METRONOME, accents: {} }],
      ['muted', { ...METRONOME, muted: 42 }]
    ]
    for (const [role, value] of cases) {
      const result = deriveTheme(asIr(value))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable: asserted above')
      expect(result.reason).toMatchObject({ kind: 'malformed', role })
    }
  })

  it('rejects a value that is not a hex colour, rather than deriving NaN tokens', () => {
    // The reviewer's second silent success: `{ …ir, fg: 'rgb(1,2,3)' }` returned
    // `ok: true` with 16 of 16 audit ratios NaN.
    const result = deriveTheme(asIr({ ...METRONOME, fg: 'rgb(1,2,3)' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'malformed',
      role: 'fg',
      detail: expect.stringContaining('hex colour')
    })
  })

  it('expands a three-digit hex — a floor rejection here, an accepted colour elsewhere', () => {
    // `{ …ir, bg: '#fff' }` used to return `ok: true` with `scrim = #NaNNaNNaN`.
    // `#fff` *is* a colour: `normalizeHex` expands it, faithfully to `derive.py`'s own
    // `normalize_hex`, so what happens next depends on the palette rather than on the
    // expansion. On this metronome every colour is #808080, so a white canvas leaves the
    // text stop 1.37:1 from it and the *text floor* rejects — the point being that a
    // ratio was measured at all, on a value whose channels are finite.
    //
    // This case used to be named "a three-digit hex becomes a floor rejection", which is
    // true only of this fixture: measured, `bg: '#fff'` derives `ok` with `ink-950 =
    // #ffffff` on the three light palettes below, and `border: '#fff'` derives `ok` on
    // twelve of the fifteen (solarized-light is the exception, pinned two cases down).
    const result = deriveTheme(asIr({ ...METRONOME, bg: '#fff' }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason.kind).toBe('floor')
    if (result.reason.kind !== 'floor') throw new Error('unreachable: asserted above')
    expect(Number.isFinite(result.reason.ratio)).toBe(true)
    expect(result.reason.role).toBe('parchment')

    // The accepted direction, pinned so the claim cannot drift back to the absolute one.
    for (const file of ['catppuccin-latte.yaml', 'gruvbox-light-soft.yaml', 'tokyo-night-light.yaml']) {
      const loaded = loadThemeFile(join(BUILTIN, file))
      if (!loaded.ok) throw new Error(`${file} did not load: ${loaded.reason}`)
      const white = deriveTheme(asIr({ ...loaded.ir, bg: '#fff' }))
      expect(white.ok).toBe(true)
      if (!white.ok) throw new Error('unreachable: asserted above')
      // Expanded to the canvas it claims to be, not coerced into something else.
      expect(white.tokens.ink['950']).toBe('#ffffff')
    }
    const dark = loadThemeFile(join(BUILTIN, 'gruvbox-dark-hard.yaml'))
    if (!dark.ok) throw new Error(dark.reason)
    expect(deriveTheme(asIr({ ...dark.ir, border: '#fff' })).ok).toBe(true)

    // And it is not unconditional either, which is why the absolute claim was the wrong
    // shape: on solarized-light a white border moves the `ok` text step 0.0068 short of
    // its 4.5:1 floor. Expansion is all `#fff` is guaranteed.
    const light = loadThemeFile(join(BUILTIN, 'solarized-light.yaml'))
    if (!light.ok) throw new Error(light.reason)
    const crippled = deriveTheme(asIr({ ...light.ir, border: '#fff' }))
    expect(crippled.ok).toBe(false)
    if (crippled.ok) throw new Error('unreachable: asserted above')
    expect(crippled.reason).toEqual({
      kind: 'floor',
      role: 'ok-400',
      ratio: 4.493254118527204,
      floor: 4.5,
      metric: 'contrast'
    })
  })

  it('reports a missing IR rather than throwing on it', () => {
    for (const value of [null, undefined]) {
      const result = deriveTheme(asIr(value))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable: asserted above')
      expect(result.reason).toEqual({
        kind: 'malformed',
        role: 'ir',
        detail: expect.stringContaining('no theme IR')
      })
    }
  })

  it('rejects the two-step path the annex advertised, instead of throwing on it', () => {
    // `parseBase16(text)` -> drop `palette.base0A` -> `base16ToIr(scheme)` ->
    // `deriveTheme(ir)`: the yellow accent the adapter fills from that key is gone,
    // which used to be a TypeError out of `hexToRgb`.
    const parsed = parseBase16(readFileSync(join(BUILTIN, 'gruvbox-dark-hard.yaml'), 'utf8'))
    if (!parsed.ok) throw new Error(parsed.reason)
    const palette = { ...parsed.scheme.palette }
    delete palette.base0A
    const ir = base16ToIr({ meta: parsed.scheme.meta, palette })
    expect(ir.accents.yellow).toBeUndefined()

    const result = deriveTheme(ir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'malformed',
      role: 'accents.yellow',
      detail: expect.stringContaining('hex colour')
    })
  })

  it('does not append to the caller’s notes, so a second derivation is identical', () => {
    // The prototype appends to the IR it is handed, and this port used to alias that
    // array. Slice 3's re-derive-on-version-mismatch path derives the same IR twice.
    const first = deriveFixture(join(BUILTIN, 'solarized-dark.yaml'))
    expect(first.notes).toEqual([])
    const loaded = loadThemeFile(join(BUILTIN, 'solarized-dark.yaml'))
    if (!loaded.ok) throw new Error(loaded.reason)
    const one = deriveTheme(loaded.ir)
    const two = deriveTheme(loaded.ir)
    if (!one.ok || !two.ok) throw new Error('unreachable: the palette derives')
    expect(one.notes).toEqual(two.notes)
    expect(loaded.ir.notes).toEqual([])
    expect(one.notes).not.toBe(loaded.ir.notes)
  })

  it('rejects a variant that is not exactly dark or light', () => {
    // `variant` has a semantic effect — it decides the direction of every ramp — and it
    // was the one required field the validation never inspected. Measured before this
    // check: each of these eight values returned `ok: true` with `dark: false` on seven
    // of the fifteen vendored palettes (this one among them), i.e. a wrong-polarity theme
    // shipped as a success; the other eight were caught by luck, by an unrelated floor.
    const loaded = loadThemeFile(join(BUILTIN, 'catppuccin-mocha.yaml'))
    if (!loaded.ok) throw new Error(loaded.reason)
    for (const variant of [undefined, null, 42, true, '', 'Dark', 'LIGHT', 'bogus']) {
      const result = deriveTheme(asIr({ ...loaded.ir, variant }))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable: asserted above')
      expect(result.reason).toEqual({
        kind: 'malformed',
        role: 'variant',
        detail: expect.stringContaining("expected 'dark' or 'light'")
      })
    }

    // The adapter's own default is untouched, which is what makes this a check on the
    // derivation rather than a change to the loader: a file with no `variant:` line still
    // loads as dark (pinned in `parse.test.ts`) and still derives.
    const text = readFileSync(join(BUILTIN, 'catppuccin-mocha.yaml'), 'utf8').replace(
      /^\s*variant:.*$/m,
      ''
    )
    expect(text).not.toContain('variant:')
    const fromFile = loadThemeText('catppuccin-mocha.yaml', text)
    if (!fromFile.ok) throw new Error(fromFile.reason)
    expect(fromFile.ir.variant).toBe('dark')
    expect(deriveTheme(fromFile.ir).ok).toBe(true)
  })

  it('rejects a field whose own toString throws, instead of calling it', () => {
    // The last place the entry point called into the caller's value: the old detail read
    // `${String(value)}`, so `deriveTheme({ …ir, bg: { toString() { throw } } })` threw
    // the caller's own error out of the frozen entry point — the same for `fg`, `border`,
    // `muted` and any accent. `describeValue` does a `typeof` first and puts the
    // conversion in a `try`.
    const boom = {
      toString(): string {
        throw new Error('BOOM from toString')
      }
    }
    for (const field of ['bg', 'fg', 'border', 'muted'] as const) {
      const result = deriveTheme(asIr({ ...METRONOME, [field]: boom }))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable: asserted above')
      expect(result.reason).toEqual({
        kind: 'malformed',
        role: field,
        detail: expect.stringContaining('got <object>')
      })
    }
    // The same arm covers a value with no primitive conversion at all: `String()` throws
    // `Cannot convert object to primitive value` on it.
    const bare = Object.create(null) as unknown
    const result = deriveTheme(asIr({ ...METRONOME, accents: { red: bare } }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'malformed',
      role: 'accents.red',
      detail: expect.stringContaining('got <object>')
    })
  })

  it('bounds the value it prints, so a long field cannot become a long reason', () => {
    // A 200-character field used to build a 227-character detail, and slice 4 prints this
    // string verbatim per row. The cap is 48 characters plus an ellipsis, and the
    // ellipsis is what tells a reader the value was cut rather than short.
    const result = deriveTheme(asIr({ ...METRONOME, bg: 'q'.repeat(200) }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: asserted above')
    expect(result.reason).toEqual({
      kind: 'malformed',
      role: 'bg',
      detail: `expected a hex colour, got ${'q'.repeat(48)}…`
    })
  })

  it('rejects a muted of null, which every other required field already rejected', () => {
    // `null` was swallowed by a `!== null` in the required-field list while six other
    // fields rejected it, so a caller that spelled "no muted" that way silently got the
    // `fg` fallback instead of a reason. Absence is still fine — that is the documented
    // fallback — and it is `undefined`, not `null`, that means absence here.
    const loaded = loadThemeFile(join(BUILTIN, 'catppuccin-mocha.yaml'))
    if (!loaded.ok) throw new Error(loaded.reason)
    const nulled = deriveTheme(asIr({ ...loaded.ir, muted: null }))
    expect(nulled.ok).toBe(false)
    if (nulled.ok) throw new Error('unreachable: asserted above')
    expect(nulled.reason).toEqual({
      kind: 'malformed',
      role: 'muted',
      detail: expect.stringContaining('got null')
    })
    expect(deriveTheme(asIr({ ...loaded.ir, muted: undefined })).ok).toBe(true)
  })

  it('drops a note that is not a string rather than coercing the caller’s value', () => {
    // `notes` is a `string[]`, and the copy used to spread whatever arrived into it. It is
    // filtered instead of coerced, for the same reason `describeValue` exists: `String()`
    // on the caller's value calls its own `toString`.
    const loaded = loadThemeFile(join(BUILTIN, 'catppuccin-mocha.yaml'))
    if (!loaded.ok) throw new Error(loaded.reason)
    const result = deriveTheme(
      asIr({
        ...loaded.ir,
        notes: ['kept', 42, { toString: () => { throw new Error('BOOM from toString') } }]
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable: asserted above')
    expect(result.notes).toEqual(['kept'])
  })

  it('hands out the discriminated failure shapes at the front door, and narrows without a cast', () => {
    // Two halves in one case. At runtime: a rejection formatted from `reason.kind` alone,
    // which is what slice 4 has to do per row. At compile time: `DeriveFailure` and
    // `FloorReason` are imported from `./index`, the engine's front door — so dropping
    // either from the barrel reddens `npm run typecheck`, and `FloorFailure` (the
    // pre-discriminant shape) is deliberately not among them.
    const result = deriveTheme(asIr({ ...METRONOME, bg: undefined }))
    if (result.ok) throw new Error('unreachable: this IR is rejected above')
    const reason: DeriveFailure = result.reason
    expect(describeFailure(reason)).toContain('bg: expected a hex colour')

    const floor: FloorReason = {
      kind: 'floor',
      role: 'parchment',
      ratio: 1,
      floor: 4.5,
      metric: 'contrast'
    }
    expect(describeFailure(floor)).toBe('parchment 1 < 4.5 (contrast)')
  })
})

/**
 * D7 — the two places the prototype's arithmetic is not JavaScript's, and the only
 * two places the port would drift from `derive.py` byte-for-byte without a reader
 * noticing: Python's `round()` is half-to-**even**, and `v ** 3` is not `v * v * v`.
 * Both are pinned from the prototype's own output. Until these existed, the only
 * thing checking either was the orchestrator's out-of-repo differential against
 * `derive.py`, which does not run for the next person.
 */
describe('D7 — the prototype’s numerics, where a default would differ', () => {
  it('rounds an exact half to even, as Python’s round() does', () => {
    // Not hypothetical: two vendored palettes land exactly on a half in the surface
    // ladder. Measured over the whole corpus — 15 palettes, 512 `rgbToHex` calls,
    // 1536 channels — four channels are exact halves and three survive into a token.
    // `Math.round` (half-up) instead answers #e2d5b0 / #434058 / #4f4b64.
    const light = deriveFixture(join(BUILTIN, 'gruvbox-light-soft.yaml'))
    expect(light.tokens.ink['800']).toBe('#e2d4b0')
    const moon = deriveFixture(join(BUILTIN, 'rose-pine-moon.yaml'))
    expect(moon.tokens.ink['700']).toBe('#424058')
    expect(moon.tokens.ink['600']).toBe('#4e4b64')

    // The tie itself: 212.5 is exactly what that channel's double multiplies to, and
    // half-to-even sends it down to 212 where half-up sends it to 213. The value is
    // `0.8333…` because the ladder's `'linear'` mix of two 8-bit channels lands on
    // an odd sum of halves; every `(k + 0.5) / 255` for k in 0..255 behaves this way.
    expect(0.8333333333333334 * 255).toBe(212.5)
    expect(rgbToHex([0.8333333333333334, 0, 0])).toBe('#d40000')
    expect(rgbToHex([0.2607843137254902, 0, 0])).toBe('#420000')
  })

  it('cubes with a power, as the prototype does', () => {
    // `v ** 3` and `v * v * v` differ in the last bits on ~40% of triples (measured:
    // 119,962 of 300,000 sampled) but are hex-visible on none of them (0 of
    // 300,000), so no hex-level case can decide this one and the literal is full
    // precision. Computed by `derive.py`'s own `oklab_to_srgb`: this is the
    // prototype's output, not this implementation's.
    const [r, g, b] = oklabToSrgb([0.8691791000000001, -0.029557, 0.123923])
    expect(r).toBe(0.8887179395297854)
    expect(g).toBe(0.846428224305747)
    expect(b).toBe(0.43481113421345424)
  })
})

/**
 * AC1.4 (J9 — moved here because slice 1's budget was exactly two files).
 *
 * A pin, not a port: the `:root` block in `src/index.css` is the palette that
 * shipped, and it must equal the pre-change literals in
 * `git show bdc54ec:tailwind.config.js`. The expected values are literals because
 * they are a frozen historical artifact — reading them out of the tree would make
 * this test agree with whatever the tree happens to say.
 */
describe('AC1.4 — the :root defaults still pin the pre-change palette', () => {
  const PRE_CHANGE: Record<string, string> = {
    '--ink-950': '#0d0b09',
    '--ink-900': '#14110d',
    '--ink-850': '#191511',
    '--ink-800': '#201b15',
    '--ink-700': '#2b241c',
    '--ink-600': '#3b3226',
    '--ink-500': '#4f4433',
    '--parchment': '#e9e1d2',
    '--parchment-dim': '#b3a78f',
    '--parchment-faint': '#7d7260',
    '--gold-300': '#e8c987',
    '--gold-400': '#d4a24e',
    '--gold-500': '#c08f3a',
    '--gold-600': '#9c7028'
  }

  function rootVars(): Record<string, string> {
    const css = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8')
    const block = css.match(/:root\s*\{([\s\S]*?)\}/)
    if (!block) throw new Error('src/index.css has no :root block')
    const vars: Record<string, string> = {}
    for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      vars[m[1]] = m[2].trim()
    }
    return vars
  }

  const toHex = (channels: string): string =>
    '#' +
    channels
      .split(/\s+/)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')

  const vars = rootVars()

  it.each(Object.entries(PRE_CHANGE))('parses %s back to its hex literal', (name, hex) => {
    expect(vars[name]).toBeDefined()
    expect(toHex(vars[name])).toBe(hex)
  })

  it('carries on-accent as the pre-change accent foreground', () => {
    expect(vars['--on-accent']).toBeDefined()
    expect(toHex(vars['--on-accent'])).toBe('#0d0b09')
  })

  it('keeps the scrim byte-equal to ink-950', () => {
    // Both sides of this comparison come from the same parse, so an empty parse
    // would compare `undefined` to `undefined` and pass. Pin the count so every
    // assertion in this block fails if the parse goes empty rather than vacuous.
    expect(Object.keys(vars)).toHaveLength(19)
    expect(vars['--scrim']).toBe(vars['--ink-950'])
  })

  it('keeps the three authored shadow alphas', () => {
    expect(vars['--shadow-a1']).toBe('0.5')
    expect(vars['--shadow-a2']).toBe('0.35')
    expect(vars['--shadow-a3']).toBe('0.6')
  })
})
