import type { ReaderPalette } from './reader-palette'

/**
 * The reader's contrast guard: the decisions, with no DOM.
 *
 * A book's own stylesheet wins over the page's (AC5.6), so a publisher who
 * hard-codes near-black text (InDesign's `#000001`) is unreadable on a dark
 * page. This module decides what counts as unreadable and what to use instead;
 * `guardSectionContrast` (same file, below) applies it to a section document.
 * Spec: `docs/superpowers/specs/2026-11-05-reader-contrast-guard-design.md`.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Below this ratio, text is overridden (D2). WCAG's AA for body text is 4.5;
 * 3 is deliberate — the guard rescues the unreadable, it does not restyle a
 * publisher's merely dim grey.
 */
export const CONTRAST_FLOOR = 3

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const FUNC = /^rgba?\(\s*([^)]*?)\s*\)$/i

function channel(token: string): number | null {
  if (!/^\d+(\.\d+)?$/.test(token)) return null
  const n = Number(token)
  return n >= 0 && n <= 255 ? n : null
}

/**
 * A computed `rgb()`/`rgba()` string (comma or space syntax) or `#rrggbb`, or
 * null — including for `transparent`, which carries no color to compare.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim()
  const hexMatch = HEX.exec(text)
  if (hexMatch) {
    const [, hr = '', hg = '', hb = ''] = hexMatch
    return { r: parseInt(hr, 16), g: parseInt(hg, 16), b: parseInt(hb, 16), a: 1 }
  }
  const fn = FUNC.exec(text)
  if (!fn) return null
  const parts = (fn[1] ?? '').split(/\s*[,/]\s*|\s+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const [pr = '', pg = '', pb = '', pa] = parts
  const r = channel(pr)
  const g = channel(pg)
  const b = channel(pb)
  if (r === null || g === null || b === null) return null
  let a = 1
  if (pa !== undefined) {
    if (!/^\d*\.?\d+$/.test(pa)) return null
    a = Math.min(1, Number(pa))
  }
  return { r, g, b, a }
}

/** `top` drawn over `bottom`; the result is opaque when `bottom` is. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG 2.x contrast ratio: symmetric, never below 1. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * The color an offending text should take, or null to leave the book alone.
 *
 * A translucent text color is composited over `bg` first (a 10%-opaque light
 * text is as unreadable as no text). An offender gets the page foreground; when
 * that fails against *this* background too (a light callout on a dark page) it
 * gets whichever of the page's foreground and background reads better (D5).
 * A palette whose pair is not `#rrggbb` leaves the book alone rather than
 * guessing.
 */
export function legibleColor(
  text: Rgba,
  bg: Rgba,
  palette: Pick<ReaderPalette, 'fg' | 'bg'>
): string | null {
  const fg = parseCssColor(palette.fg)
  const pageBg = parseCssColor(palette.bg)
  if (!fg || !pageBg || !HEX.test(palette.fg) || !HEX.test(palette.bg)) return null
  // Fully transparent text is hidden on purpose (an OCR layer over a scan, a
  // background-clip heading, screen-reader-only text): never make it visible.
  if (text.a <= 0.01) return null
  const seen = text.a < 1 ? compositeOver(text, bg) : text
  if (contrastRatio(seen, bg) >= CONTRAST_FLOOR) return null
  if (contrastRatio(fg, bg) >= CONTRAST_FLOOR) return palette.fg
  return contrastRatio(fg, bg) >= contrastRatio(pageBg, bg) ? palette.fg : palette.bg
}

// ---------------------------------------------------------------------------
// Code chips
// ---------------------------------------------------------------------------

/**
 * A monospace element's own background is "glaring" when it contrasts with the
 * page by more than this. A cream `#f0eee6` chip on the `ink` page is ~16:1; the
 * same chip on the `paper` page is ~1:1 and is left alone. 4 sits well clear of
 * both: a mid-grey chip on a dark page (about 2:1) is a design, not a glare.
 */
export const CHIP_GLARE = 4

/** How much of the page foreground the replacement chip carries over the page. */
const CHIP_TINT = 0.08

/**
 * Text on a chip this module restyled is held to a higher bar than the page's
 * 3:1: the chip's background is now ours, so its legibility is too. 3.02:1 purple
 * on the tint was reported unreadable, and 4.5:1 (AA) was still reported too dim
 * (2026-11-13) — the book sets code in Courier New, whose hairline strokes read
 * lighter than their ratio says. 7 is WCAG AAA; past ~8 a purple washes out to grey.
 */
export const CHIP_TEXT_FLOOR = 7

const MONOSPACE = /monospace|\b(?:courier|menlo|monaco|consolas|mono)\b/i

function toHex(c: Rgba): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${part(c.r)}${part(c.g)}${part(c.b)}`
}

/**
 * The background a code chip should take on this page, or null to leave the
 * book's own.
 *
 * Code in a book is routinely a bright chip behind purple or black monospace
 * text, which reads well on a white page and as a hole punched in a dark one.
 * The signal is the *font* (monospace) plus an own background that
 * glares against the page — not a tag name, because exports like this one style
 * code with `<span class="…">`. A bright box that is not monospace is a callout
 * and stays (AC3), and so does a chip inside a bright box (`under` is what the
 * element sits on). A translucent background is composited over `under` first, so a
 * faint wash never counts as a glare. The replacement is the page color with a little of its own
 * foreground in it: a chip that is still visibly a chip, on-theme on any palette.
 */
export function chipBackground(
  own: Rgba | null,
  fontFamily: string,
  under: Rgba,
  palette: Pick<ReaderPalette, 'fg' | 'bg'>
): string | null {
  const fg = parseCssColor(palette.fg)
  const page = parseCssColor(palette.bg)
  if (!fg || !page || !HEX.test(palette.fg) || !HEX.test(palette.bg)) return null
  if (!MONOSPACE.test(fontFamily)) return null
  if (!own || own.a <= 0) return null
  if (contrastRatio(under, page) >= CHIP_GLARE) return null
  if (contrastRatio(compositeOver(own, under), page) < CHIP_GLARE) return null
  return toHex(compositeOver({ ...fg, a: CHIP_TINT }, page))
}

/**
 * The color a chip's text should take so it clears `CHIP_TEXT_FLOOR` on `bg`, or
 * null when it already does. It keeps the book's hue: the text is mixed toward
 * the page foreground by the least amount that reaches the floor (a binary
 * search, so a purple stays a lighter purple instead of becoming body text).
 * Text under the ordinary floor never gets here — `legibleColor` repaints that
 * with the foreground outright.
 */
export function chipTextColor(
  text: Rgba,
  bg: Rgba,
  palette: Pick<ReaderPalette, 'fg' | 'bg'>
): string | null {
  const fg = parseCssColor(palette.fg)
  if (!fg || !HEX.test(palette.fg) || !HEX.test(palette.bg)) return null
  if (text.a <= 0.01) return null
  const seen = text.a < 1 ? compositeOver(text, bg) : text
  if (contrastRatio(seen, bg) >= CHIP_TEXT_FLOOR) return null
  // Measure the color that will actually be painted: the search runs on the
  // `#rrggbb` it would write, because rounding to a byte can land a hair under the
  // floor that the unrounded mix cleared.
  const painted = (t: number): string => toHex(compositeOver({ ...fg, a: t }, { ...seen, a: 1 }))
  const reads = (t: number): boolean => {
    const c = parseCssColor(painted(t))
    return c !== null && contrastRatio(c, bg) >= CHIP_TEXT_FLOOR
  }
  if (!reads(1)) return painted(1)
  let lo = 0
  let hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (reads(mid)) hi = mid
    else lo = mid
  }
  return painted(hi)
}

// ---------------------------------------------------------------------------
// The DOM pass
// ---------------------------------------------------------------------------

/** The marker on every element this module has overridden (D6). */
export const CONTRAST_ATTR = 'data-musaeum-contrast'

/** The marker on every element whose background this module has replaced. */
export const CHIP_ATTR = 'data-musaeum-chip'

/**
 * What the pass reads off an element; `getComputedStyle` satisfies it. A source
 * that does not report `fontFamily` simply gets no chip handling.
 */
export type ComputedSource = (el: Element) => {
  color: string
  backgroundColor: string
  fontFamily?: string
}

const TEXT_NODE = 3
/** Subtrees whose text is never painted as page prose. */
const SKIPPED = new Set(['script', 'style', 'svg', 'noscript', 'head', 'title'])

function ownsText(el: Element): boolean {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === TEXT_NODE && (node.textContent ?? '').trim() !== '') return true
  }
  return false
}

function inSkippedSubtree(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (SKIPPED.has(cur.tagName.toLowerCase())) return true
  }
  return false
}

/**
 * What an element's text is drawn over (D3): the nearest ancestors' background
 * colors composited down onto the page color. The page color is `palette.bg`,
 * not the document's computed body background, so the answer does not depend on
 * whether the injected stylesheet has been applied when a section loads.
 * `background-image` is ignored (a stated non-goal).
 */
function ownBackground(
  el: Element,
  computed: ComputedSource,
  cache: Map<Element, Rgba | null>
): Rgba | null {
  let c = cache.get(el)
  if (c === undefined) {
    c = parseCssColor(computed(el).backgroundColor)
    cache.set(el, c)
  }
  return c
}

function effectiveBackground(
  el: Element | null,
  computed: ComputedSource,
  page: Rgba,
  cache: Map<Element, Rgba | null>
): Rgba {
  const layers: Rgba[] = []
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const c = ownBackground(cur, computed, cache)
    if (c && c.a > 0) {
      layers.push(c)
      if (c.a >= 1) break
    }
  }
  return layers.reduceRight((under, layer) => compositeOver(layer, under), page)
}

/** Undo one marker's overrides: drop the inline property, give back what the book had. */
function clearMarked(doc: Document, attr: string, property: string): void {
  for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
    const saved = el.getAttribute(attr)
    ;(el as HTMLElement).style.removeProperty(property)
    if (saved) {
      try {
        const { v, p } = JSON.parse(saved) as { v: string; p: string }
        if (typeof v === 'string' && v) {
          ;(el as HTMLElement).style.setProperty(property, v, typeof p === 'string' ? p : '')
        }
      } catch {
        /* an unreadable marker restores nothing; the override is still gone */
      }
    }
    el.removeAttribute(attr)
  }
}

/** Remove every override this module made in `doc`, restoring a prior inline value. */
function clearOverrides(doc: Document): void {
  clearMarked(doc, CONTRAST_ATTR, 'color')
  clearMarked(doc, CHIP_ATTR, 'background-color')
}

/** Mark `el` and set one property on it as an inline `!important`, remembering what it had. */
function override(el: Element, attr: string, property: string, value: string): void {
  const style = (el as HTMLElement).style
  const prior = style.getPropertyValue(property)
  el.setAttribute(
    attr,
    prior ? JSON.stringify({ v: prior, p: style.getPropertyPriority(property) }) : ''
  )
  style.setProperty(property, value, 'important')
}

/**
 * Make illegible text legible in one section document, and quiet a glaring code
 * chip (`chipBackground`) — and nothing else (D4–D8).
 *
 * Clears this module's earlier overrides first, so it is safe to call again after
 * a palette change: a book that was overridden on a dark page gets its own color
 * back on a light one. Only elements that own text are examined, only those under
 * the contrast floor are changed, and every failure is local — an element or a
 * section that cannot be read keeps the book's own color and nothing throws.
 */
export function guardSectionContrast(
  doc: Document,
  palette: Pick<ReaderPalette, 'bg' | 'fg'>,
  computed?: ComputedSource
): void {
  try {
    const view = doc.defaultView
    const source: ComputedSource | null =
      computed ?? (view ? (el) => view.getComputedStyle(el) : null)
    if (!source) return
    const page = parseCssColor(palette.bg)
    if (!page) return
    clearOverrides(doc)
    // Two phases, reads then writes. Interleaving them dirties style before the
    // next getComputedStyle, which forces a recalculation per offender — on a
    // book where every paragraph offends that is thousands of them. With no write
    // between reads, an ancestor's background is also read once for the pass.
    const backgrounds = new Map<Element, Rgba | null>()
    const pending: { el: Element; next: string }[] = []
    const chips: { el: Element; next: string }[] = []
    const chipEls = new Set<Element>()
    const inChip = (el: Element): boolean => {
      for (let cur: Element | null = el; cur; cur = cur.parentElement)
        if (chipEls.has(cur)) return true
      return false
    }
    // Document order: an ancestor is decided before its descendants, so a restyled
    // chip's tint is already in `backgrounds` when the text inside it is judged.
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      try {
        if (inSkippedSubtree(el)) continue
        const style = source(el)
        const tint = style.fontFamily
          ? chipBackground(
              ownBackground(el, source, backgrounds),
              style.fontFamily,
              effectiveBackground(el.parentElement, source, page, backgrounds),
              palette
            )
          : null
        const tinted = tint ? parseCssColor(tint) : null
        if (tint && tinted) {
          chips.push({ el, next: tint })
          chipEls.add(el)
          backgrounds.set(el, tinted)
        }
        if (!ownsText(el)) continue
        const text = parseCssColor(style.color)
        if (!text) continue
        const under = effectiveBackground(el, source, page, backgrounds)
        const next =
          legibleColor(text, under, palette) ??
          (inChip(el) ? chipTextColor(text, under, palette) : null)
        if (next) pending.push({ el, next })
      } catch {
        /* this element keeps the book's colors */
      }
    }
    for (const { el, next } of pending) {
      try {
        override(el, CONTRAST_ATTR, 'color', next)
      } catch {
        /* this element keeps the book's color */
      }
    }
    for (const { el, next } of chips) {
      try {
        override(el, CHIP_ATTR, 'background-color', next)
      } catch {
        /* this element keeps the book's background */
      }
    }
  } catch {
    /* this section keeps the book's colors */
  }
}
