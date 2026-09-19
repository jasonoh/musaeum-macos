import type { ThemeTokens } from '@shared/theme.types'

/**
 * The reader's page palette: the two rows the reader has always shipped with,
 * plus the derivation that makes them follow the app's theme.
 *
 * **Why this is literals and not CSS variables.** The book renders in its own
 * iframe document, which the app's stylesheet does not reach. So the page's
 * colours cannot be Tailwind classes, and they cannot be `var(--ink-900)`
 * either: the custom properties live on the *app's* `:root`, the book document
 * has no access to them, and `vendor/foliate-js/paginator.js:191` reads the
 * book document's background back out with a string comparison
 * (`=== 'rgba(0, 0, 0, 0)'`) and re-applies it at `:626`, `:685` and `:1113` to
 * paint the margin around the page. An unresolved value takes that fallback
 * branch and the page colour stops at the iframe edge (AC5.7). Every value in
 * this module is therefore a plain `#rrggbb` literal.
 *
 * **Why the store import is absent.** D3: this module is pure — a token set in,
 * a palette out — so its rules are decidable with no DOM and no store seeding.
 * The components that already read the reader store read the theme store beside
 * it; that is their business, not this file's.
 */

/** The reader's page theme, as persisted. `auto` follows the app theme. */
export type ReaderPageTheme = 'auto' | 'ink' | 'paper'

export interface ReaderPalette {
  bg: string
  fg: string
  dim: string
  link: string
  /**
   * The link colour with its alpha **already composed onto it** (`#d4a24e44`).
   *
   * A field of its own rather than `${c.link}44` written at the rule: that
   * concatenation is only valid CSS while `link` happens to be a hex literal,
   * and the moment it is anything else (`var(--gold-400)`, a `color-mix()`) the
   * declaration is invalid, the rule is dropped, and the book's selection falls
   * back to the platform's blue — in the one place the app's accent is most
   * visible (AC5.8).
   */
  linkAlphaHex: string
  /**
   * The colour a search hit is outlined in — the derived link colour, threaded
   * as its own field (D1) rather than read back off `link` at the call site.
   *
   * The role exists because `ReaderSearch` draws its outline inside
   * foliate-view's **closed shadow root**, where a custom property is a bet this
   * repo does not take, so the colour has to travel as a literal. Naming it is
   * what lets it be derived; D1 has this slice keep it equal to `link`, which is
   * what both authored rows already do.
   */
  search: string
  /**
   * The book document's own `color-scheme`, taken from the tokens rather than
   * from the pref (D2): the pref says which row to use, and only the resolved
   * palette knows whether that row is a light one.
   */
  scheme: 'dark' | 'light'
}

/**
 * Today's `ink` row, byte for byte, with the one addition S1's search role made
 * to it (`search` is `link`). Kept as an authored row rather than folded into
 * the derivation because it is what a stored `theme: 'ink'` still means.
 */
export const INK_PALETTE: ReaderPalette = {
  bg: '#14110d',
  fg: '#e9e1d2',
  dim: '#b3a78f',
  link: '#d4a24e',
  linkAlphaHex: '#d4a24e44',
  search: '#d4a24e',
  scheme: 'dark'
}

/**
 * The authored warm-paper row — unchanged, and the one reader theme that is a
 * choice rather than a consequence of the app theme. It now has a token
 * counterpart to sit beside (a light app theme derives a light page), which it
 * did not when this table was a fork of `tailwind.config.js`.
 */
export const PAPER_PALETTE: ReaderPalette = {
  bg: '#f3ece0',
  fg: '#241f18',
  dim: '#6b6152',
  link: '#8a5a1a',
  linkAlphaHex: '#8a5a1a44',
  search: '#8a5a1a',
  scheme: 'light'
}

/** The only shape a colour interpolated into the page stylesheet may have. */
const HEX = /^#[0-9a-f]{6}$/

/** A value that is a hex colour, or null — the guard `readerPalette` is total on. */
function hexOrNull(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value : null
}

/**
 * The page, derived from the app's active token set.
 *
 * The mapping is **`ink-900` / `parchment` / `parchment_dim` / `gold-400`**, and
 * it is what makes the built-in default a visual no-op: on that theme the four
 * derived values are `#14110d` / `#e9e1d2` / `#b3a78f` / `#d4a24e`, which is the
 * `ink` row above, value for value (AC5.2 — asserted, not assumed). The choice
 * is also theme-agnostic: on a light theme those same roles give a light page
 * with dark text, which is what a page *is*.
 *
 * **Total, deliberately.** `/^#[0-9a-f]{6}$/` is not decoration: it is the
 * module's only guarantee that the string it hands `readerPageCss` cannot be
 * interpolated into an invalid declaration. Main validates every stored theme
 * before it writes one (`theme/store.ts`'s `colourProblem`), so a set that fails
 * this is a caller `src/` does not have today — and if one appears, the page gets
 * the ink row rather than `background: undefined;`, which the engine's read-back
 * would then treat as transparent (the AC5.7 failure) with nothing reporting it.
 * Reporting a palette that cannot be applied is `css.ts`'s business; a page
 * always having a colour is this function's.
 */
export function readerPalette(tokens: ThemeTokens | null | undefined): ReaderPalette {
  const bg = hexOrNull(tokens?.ink?.['900'])
  const fg = hexOrNull(tokens?.parchment?.parchment)
  const dim = hexOrNull(tokens?.parchment?.parchment_dim)
  const link = hexOrNull(tokens?.gold?.['400'])
  if (!bg || !fg || !dim || !link) return INK_PALETTE
  return {
    bg,
    fg,
    dim,
    link,
    linkAlphaHex: `${link}44`,
    search: link,
    scheme: tokens?.dark ? 'dark' : 'light'
  }
}

/**
 * The stored pref, resolved against whatever tokens are active.
 *
 * `tokens === null` is not an error: it is "the renderer has not been seeded
 * yet", and `:root`'s authored palette is what is on screen at that moment — the
 * same row the `ink` literal carries, so the fallback cannot show a page that
 * disagrees with the frame around it.
 */
export function resolveReaderPalette(
  theme: ReaderPageTheme,
  tokens: ThemeTokens | null
): ReaderPalette {
  if (theme === 'ink') return INK_PALETTE
  if (theme === 'paper') return PAPER_PALETTE
  return tokens ? readerPalette(tokens) : INK_PALETTE
}

/**
 * The prefs `readerPageCss` consumes. The store's `ReaderPrefs` satisfies it
 * structurally — extra fields and all — which is what keeps this module free of
 * a store import. `theme` rides along for the caller's sake: the resolved
 * palette already carries the scheme the rule needs.
 */
export interface ReaderPagePrefs {
  theme: ReaderPageTheme
  typeface: 'serif' | 'sans'
  fontSize: number
  lineHeight: number
}

const SERIF = '"Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif'
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'

/**
 * Styles injected *into* the book's document. Deliberately unprefixed by
 * `!important`: a book that ships its own typography keeps it, and these only
 * fill in what it left unsaid (AC5.6).
 *
 * Moved here verbatim from `ReaderEngine.tsx` when the palette became derived.
 * The rules are unchanged — only the colours' source changed: every
 * interpolation is now a field of the resolved palette, so the string carries no
 * `var(` and no value that has to be composed at the rule (AC5.7/AC5.8).
 */
export function readerPageCss(prefs: ReaderPagePrefs, palette: ReaderPalette): string {
  const c = palette
  const family = prefs.typeface === 'serif' ? SERIF : SANS
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      color-scheme: ${palette.scheme};
      font-size: ${prefs.fontSize}px;
      background: ${c.bg};
      color: ${c.fg};
      font-family: ${family};
    }
    body {
      background: ${c.bg};
      color: ${c.fg};
      font-family: ${family};
    }
    p, li, blockquote, dd, td {
      line-height: ${prefs.lineHeight};
      -webkit-hyphens: auto;
      hyphens: auto;
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
      -webkit-hyphenate-limit-lines: 2;
      hanging-punctuation: allow-end last;
      widows: 2;
      orphans: 2;
    }
    /* Keep the above from overriding an explicit alignment */
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    h1, h2, h3, h4, h5, h6 {
      font-family: ${SERIF};
      line-height: 1.2;
      font-weight: 600;
      -webkit-hyphens: manual;
      hyphens: manual;
    }
    a, a:link, a:visited { color: ${c.link}; }
    hr { border: 0; border-top: 1px solid ${c.dim}; opacity: 0.4; }
    pre { white-space: pre-wrap !important; }
    ::selection { background: ${c.linkAlphaHex}; }
  `
}
