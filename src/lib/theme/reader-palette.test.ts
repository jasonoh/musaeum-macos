import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ThemeTokens } from '@shared/theme.types'
import {
  INK_PALETTE,
  PAPER_PALETTE,
  readerPageCss,
  readerPalette,
  resolveReaderPalette,
  type ReaderPagePrefs
} from './reader-palette'

/**
 * The derived page, decided without a DOM and without a store (D3).
 *
 * There is no `document` in this environment (`environment: 'node'`, no jsdom),
 * which is the reason the palette is a pure function of a token set: everything
 * this slice claims about a themed page is a comparison between two values.
 *
 * **The default theme is read from `src/index.css`, not imported.** AC5.2's
 * subject is the theme a user is running when nothing is configured, and the
 * literal it lives in is `MUSAEUM_DEFAULT_TOKENS` — which this file cannot
 * import: `tsconfig.web.json` lists `src/**` and `test/**` only, and a `src`
 * test importing `electron/main/services/theme/store` is a `TS6307` ("not listed
 * within the file list of project") plus thirteen `TS2307`s for the inlined
 * corpus, i.e. `npm run typecheck` fails. So it takes the route the AC table's
 * second clause names — *equals what `:root` carries* — with the identical
 * parse `src/lib/theme/css.test.ts` uses. The other half of the chain already
 * exists: `electron/main/services/theme/store.test.ts` pins
 * `MUSAEUM_DEFAULT_TOKENS` against this same `:root` block, channel by channel.
 */

const ROOT_CSS = join(process.cwd(), 'src', 'index.css')

/** `:root`'s custom properties, keyed by name — the parse slice 1 pins. */
function rootVars(): Record<string, string> {
  const css = readFileSync(ROOT_CSS, 'utf8')
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)
  if (!block) throw new Error('src/index.css has no :root block')
  const vars: Record<string, string> = {}
  for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) vars[m[1]] = m[2].trim()
  return vars
}

/** '13 11 9' → '#0d0b09', the inverse of `hexToChannels`. */
function hexFromChannels(channels: string): string {
  return (
    '#' +
    channels
      .split(/\s+/)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** `:root`, as a token set — so the default is not restated here as literals. */
function tokensFromRoot(vars: Record<string, string>): ThemeTokens {
  const inkAt = (step: string): string => hexFromChannels(vars[`--ink-${step}`])
  return {
    ink: {
      '950': inkAt('950'),
      '900': inkAt('900'),
      '850': inkAt('850'),
      '800': inkAt('800'),
      '700': inkAt('700'),
      '600': inkAt('600'),
      '500': inkAt('500')
    },
    parchment: {
      parchment: hexFromChannels(vars['--parchment']),
      parchment_dim: hexFromChannels(vars['--parchment-dim']),
      parchment_faint: hexFromChannels(vars['--parchment-faint'])
    },
    gold: {
      '300': hexFromChannels(vars['--gold-300']),
      '400': hexFromChannels(vars['--gold-400']),
      '500': hexFromChannels(vars['--gold-500']),
      '600': hexFromChannels(vars['--gold-600'])
    },
    on_acc: hexFromChannels(vars['--on-accent']),
    scrim: hexFromChannels(vars['--scrim']),
    // The engine's strength for a dark canvas — the bridge `css.ts` scales the
    // three authored alphas with (A24), not one of the alphas themselves.
    shadow: 0.55,
    dark: true
  }
}

const DEFAULT_TOKENS = tokensFromRoot(rootVars())

/**
 * A light palette, so "the reader follows the app theme" is decided against
 * something that differs from the default in every one of the four colours.
 */
const LIGHT_TOKENS: ThemeTokens = {
  ink: { ...DEFAULT_TOKENS.ink, '900': '#fdf6e3' },
  parchment: { parchment: '#073642', parchment_dim: '#586e75', parchment_faint: '#839496' },
  gold: { ...DEFAULT_TOKENS.gold, '400': '#b58900' },
  on_acc: DEFAULT_TOKENS.on_acc,
  scrim: DEFAULT_TOKENS.scrim,
  shadow: 0.16,
  dark: false
}

const PREFS: ReaderPagePrefs = {
  theme: 'auto',
  typeface: 'serif',
  fontSize: 18,
  lineHeight: 1.6
}

describe('readerPalette', () => {
  it('derives today’s ink row, value for value, from the default theme (AC5.2)', () => {
    // The default path is a visual no-op: `ink-900` / `parchment` /
    // `parchment_dim` / `gold-400` on the built-in theme *are* the authored row.
    // Spelled out as literals as well as compared to the row, so a mutation that
    // moved the mapping (to `ink-950`, say) fails on the first assertion rather
    // than on a comparison that could be satisfied by changing both sides.
    expect(readerPalette(DEFAULT_TOKENS)).toEqual({
      bg: '#14110d',
      fg: '#e9e1d2',
      dim: '#b3a78f',
      link: '#d4a24e',
      linkAlphaHex: '#d4a24e44',
      search: '#d4a24e',
      scheme: 'dark'
    })
    expect(readerPalette(DEFAULT_TOKENS)).toEqual(INK_PALETTE)
  })

  it('maps the page to ink-900 / parchment / parchment_dim / gold-400', () => {
    const light = readerPalette(LIGHT_TOKENS)
    expect(light.bg).toBe(LIGHT_TOKENS.ink['900'])
    expect(light.fg).toBe(LIGHT_TOKENS.parchment.parchment)
    expect(light.dim).toBe(LIGHT_TOKENS.parchment.parchment_dim)
    expect(light.link).toBe(LIGHT_TOKENS.gold['400'])
  })

  it('differs from the ink row in all four colours on a light theme (AC5.1)', () => {
    const light = readerPalette(LIGHT_TOKENS)
    const row = { bg: light.bg, fg: light.fg, dim: light.dim, link: light.link }
    for (const [name, value] of Object.entries(row)) {
      expect(value, name).not.toBe(INK_PALETTE[name as keyof typeof row])
    }
  })

  it('takes the book’s color-scheme from the tokens, not from a pref (D2)', () => {
    expect(readerPalette(DEFAULT_TOKENS).scheme).toBe('dark')
    expect(readerPalette(LIGHT_TOKENS).scheme).toBe('light')
  })

  it('threads search as the derived link colour (D1)', () => {
    // A named field rather than a second read of `link`: it is the role S1 added
    // so that a themed app cannot outline hits in a hardcoded amber.
    expect(readerPalette(LIGHT_TOKENS).search).toBe(readerPalette(LIGHT_TOKENS).link)
    expect(INK_PALETTE.search).toBe(INK_PALETTE.link)
    expect(PAPER_PALETTE.search).toBe(PAPER_PALETTE.link)
  })

  it('composes the alpha onto the link rather than leaving it to the rule (AC5.8)', () => {
    // The *shape* is the assertion, because comparing this field to
    // `` `${palette.link}44` `` would restate the implementation and pass for any
    // link at all — including one that is not a colour at all
    // (`'var(--gold-400)44'` satisfies that comparison and is exactly the defect).
    // What has to hold is that the field is a composed literal with the link's own
    // six digits in front of the alpha; the source walk below decides that the
    // composition happens here and nowhere else.
    for (const palette of [readerPalette(LIGHT_TOKENS), INK_PALETTE, PAPER_PALETTE]) {
      expect(palette.link, palette.link).toMatch(/^#[0-9a-f]{6}$/)
      expect(palette.linkAlphaHex, palette.link).toMatch(/^#[0-9a-f]{6}44$/)
      expect(palette.linkAlphaHex.slice(0, 7)).toBe(palette.link)
    }
  })
})

describe('resolveReaderPalette', () => {
  it('ignores the tokens entirely for the two authored rows', () => {
    // An old stored `'ink'` keeps meaning what it meant, whatever the app theme
    // is doing — and the light set is the case where that is worth asserting.
    expect(resolveReaderPalette('ink', LIGHT_TOKENS)).toEqual(INK_PALETTE)
    expect(resolveReaderPalette('paper', LIGHT_TOKENS)).toEqual(PAPER_PALETTE)
    expect(resolveReaderPalette('ink', null)).toEqual(INK_PALETTE)
  })

  it('is the ink row for auto with no tokens yet, because that is what :root shows', () => {
    // Null tokens is "the renderer has not been seeded": `:root`'s authored
    // palette is on screen, and it is the row the ink literal carries.
    expect(resolveReaderPalette('auto', null)).toEqual(INK_PALETTE)
  })

  it('is total: a set it cannot read becomes the ink row, never `undefined`', () => {
    // The other direction of AC5.7. A page colour that is not a hex literal —
    // `undefined` from a hand-edited `theme_tokens` row, say — would be an invalid
    // declaration the engine's read-back then treats as transparent, and it would
    // reach the stylesheet with nothing reporting it. Main validates everything it
    // sends, so this is not a caller src/ has today; it is the guard that keeps the
    // next one from painting a broken page.
    const broken = {
      ...LIGHT_TOKENS,
      gold: { ...LIGHT_TOKENS.gold, '400': undefined as unknown as string }
    }
    expect(readerPalette(broken)).toEqual(INK_PALETTE)
    expect(readerPalette(undefined)).toEqual(INK_PALETTE)
    expect(readerPageCss(PREFS, readerPalette(broken))).not.toContain('undefined')
  })

  it('follows the tokens for auto', () => {
    const resolved = resolveReaderPalette('auto', LIGHT_TOKENS)
    expect(resolved).toEqual(readerPalette(LIGHT_TOKENS))
    expect(resolved.scheme).toBe('light')
    expect(resolved.bg).not.toBe(INK_PALETTE.bg)
  })
})

describe('readerPageCss', () => {
  const css = readerPageCss(PREFS, readerPalette(LIGHT_TOKENS))

  it('composes the selection colour as a literal, with the link’s own six digits (AC5.8)', () => {
    // The declaration the alpha-suffix pattern silently turns invalid: `${link}44`
    // is valid only while `link` is a hex literal, and a dropped `::selection`
    // rule is the UA's blue in the reader's most visible accent.
    expect(css).toMatch(/::selection \{ background: #[0-9a-f]{6}44; \}/)
    const selection = /::selection \{ background: (#[0-9a-f]{6})44; \}/.exec(css)
    expect(selection?.[1]).toBe(readerPalette(LIGHT_TOKENS).link)
  })

  it('contains no var( and only valid hex literals (AC5.7)', () => {
    // A custom property is defined on the *app's* `:root` and the book renders in
    // its own document: an unresolved value makes the paginator's own background
    // transparent, so the page colour stops at the iframe edge.
    expect(css).not.toContain('var(')
    const hexes = css.match(/#[0-9a-f]+/gi) ?? []
    expect(hexes.length).toBeGreaterThan(0)
    // Six digits, or six plus the composed selection alpha — and nothing else:
    // an 8-digit run that is not the link's own alpha is the paste-back pattern
    // arriving some other way.
    for (const hex of hexes) {
      expect(hex, hex).toMatch(/^#[0-9a-f]{6}(44)?$/)
      if (hex.length > 7) expect(hex).toBe(`${readerPalette(LIGHT_TOKENS).link}44`)
    }

    // And the values really are the resolved palette, not the authored row.
    expect(css).toContain(`background: ${readerPalette(LIGHT_TOKENS).bg};`)
    expect(css).toContain(`color: ${readerPalette(LIGHT_TOKENS).fg};`)
    expect(css).not.toContain(INK_PALETTE.bg)
  })

  it('carries the typography and the namespace declaration unchanged', () => {
    expect(css).toContain('@namespace epub "http://www.idpf.org/2007/ops";')
    expect(css).toContain('font-size: 18px;')
    expect(readerPageCss({ ...PREFS, fontSize: 22 }, INK_PALETTE)).toContain('font-size: 22px;')
    expect(readerPageCss({ ...PREFS, lineHeight: 1.8 }, INK_PALETTE)).toContain('line-height: 1.8;')
    expect(readerPageCss({ ...PREFS, typeface: 'sans' }, INK_PALETTE)).toContain('-apple-system')
  })

  it('takes color-scheme from the palette rather than from the pref (D2)', () => {
    // `paper` in the prefs with an ink palette: the pref names which row to use,
    // and only the resolved palette knows whether that row is a light one.
    const inkRule = readerPageCss({ ...PREFS, theme: 'paper' }, INK_PALETTE)
    expect(inkRule).toContain('color-scheme: dark;')
    expect(readerPageCss({ ...PREFS, theme: 'ink' }, PAPER_PALETTE)).toContain(
      'color-scheme: light;'
    )
    expect(css).toContain('color-scheme: light;')
  })

  it('is byte-identical for the default theme and the authored ink row (AC5.2)', () => {
    expect(readerPageCss(PREFS, resolveReaderPalette('auto', DEFAULT_TOKENS))).toBe(
      readerPageCss(PREFS, INK_PALETTE)
    )
    expect(readerPageCss(PREFS, resolveReaderPalette('auto', DEFAULT_TOKENS))).toContain(
      '::selection { background: #d4a24e44; }'
    )
  })

  /**
   * AC5.8's other half, and the one the criterion's mutation actually targets:
   * pasting `${c.link}44` back at the rule produces *this* palette's exact
   * output, so no assertion on the string alone can see it. What can is the
   * source — the composition has to live in the palette, where it is one field
   * the resolver hands over, and nowhere in the stylesheet may an interpolation
   * be followed by an alpha suffix.
   */
  it('composes no alpha suffix anywhere in the stylesheet itself (AC5.8)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'lib', 'theme', 'reader-palette.ts'),
      'utf8'
    )
    const stylesheet = source.slice(source.indexOf('export function readerPageCss'))
    expect(stylesheet).not.toBe('')
    expect(stylesheet).not.toMatch(/\$\{[^}]*\}44/)
    // The palette is where it happens, once, and the field is what the rule reads.
    expect(source).toMatch(/linkAlphaHex: `\$\{link\}44`/)
    expect(stylesheet).toContain('${c.linkAlphaHex}')
  })

  /**
   * AC5.6 — the injected rules stay unprefixed, and this is where a blanket
   * "no `!important`" assertion would be wrong: the stylesheet legitimately
   * carries one, on the `pre` white-space rule, and it predates this slice.
   * What must not appear is `!important` on a *colour* declaration, which is
   * AC5.6's named mutation (a book that ships its own typography would lose it).
   */
  it('leaves every colour declaration unprefixed, bar the pre-existing one (AC5.6)', () => {
    const important = css.match(/[^;{}]*!important[^;{}]*/g) ?? []
    expect(important).toHaveLength(1)
    expect(important[0]).toContain('white-space: pre-wrap')
    // Named rather than counted, so the assertion says which rule it allowed.
    for (const declaration of css.match(/(background|color|color-scheme|border-top):[^;]*/g) ??
      []) {
      expect(declaration).not.toContain('!important')
    }
  })
})

/**
 * The reader wiring, which is the half of AC5.1 a pure function cannot decide:
 * `resolveReaderPalette` following the tokens is worth nothing if the components
 * hand it the ink row, or null, or forget to re-run when the theme changes.
 *
 * There is no DOM and no React in this environment, so the instrument is a
 * source walk — the same decider `CLAUDE.md`'s repo uses for AC4.4 and slice 3's
 * `main/index.ts` (A25). Its limit is stated: it proves the wiring is written,
 * not that React calls it. The live half (a book repainting on a theme change
 * with the book open) is the running-app pass.
 */
describe('the reader components read the theme through the palette (AC5.1)', () => {
  const ENGINE = readFileSync(
    join(process.cwd(), 'src', 'components', 'reader', 'ReaderEngine.tsx'),
    'utf8'
  )
  const SEARCH = readFileSync(
    join(process.cwd(), 'src', 'components', 'reader', 'ReaderSearch.tsx'),
    'utf8'
  )

  it('takes the tokens from the theme store in both places that resolve a palette', () => {
    for (const source of [ENGINE, SEARCH]) {
      expect(source).toContain('useThemeStore((s) => s.view?.active.tokens')
    }
  })

  it('resolves through the tokens on both of the engine’s paths', () => {
    // The restyle path — the one a theme change takes while a book is open.
    expect(ENGINE).toContain('resolveReaderPalette(prefs.theme, tokens)')
    // The open path, which reads the same two values through refs so a theme
    // change mid-load colours the page it is about to show.
    expect(ENGINE).toContain('resolveReaderPalette(prefsRef.current.theme, tokensRef.current)')
  })

  it('re-runs the restyle when the theme changes, not only when the prefs do', () => {
    // Dropping `tokens` from this list is the mutation: the page would keep the
    // previous theme until the book was reopened.
    expect(ENGINE).toContain('}, [prefs, tokens, viewRef])')
  })

  it('re-runs the search when the highlight colour moves', () => {
    // The vendor draws annotations per run and keeps the options it was handed
    // (`view.js:545`'s `#searchDrawOptions`, re-applied on every section render),
    // so without this the outlines keep the colour of the run that drew them —
    // measured: flipping the theme with five hits up left ~1,780 orange pixels
    // orange against a page that had gone dark. The page follows the theme; the
    // highlighting has to follow it with the page.
    expect(SEARCH).toContain('const searchColour = resolveReaderPalette(theme, tokens).search')
    expect(SEARCH).toContain('color: searchColour')
    expect(SEARCH).toMatch(/drawnColour\.current === searchColour/)
    expect(SEARCH).toContain('if (ranQuery) void startRef.current()')
  })

  it('never reaches for an authored row directly, in either component', () => {
    // The rows are what a stored `ink`/`paper` *resolves to*, never a colour a
    // component may pick up on its own — a second read of one is how a themed app
    // ends up with an unthemed page or an unthemed search outline.
    for (const source of [ENGINE, SEARCH]) {
      expect(source).not.toMatch(/\b(INK_PALETTE|PAPER_PALETTE)\b/)
    }
    expect(SEARCH).toContain('.search')
  })
})
