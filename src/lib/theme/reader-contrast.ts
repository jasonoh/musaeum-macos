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
    return {
      r: parseInt(hexMatch[1], 16),
      g: parseInt(hexMatch[2], 16),
      b: parseInt(hexMatch[3], 16),
      a: 1
    }
  }
  const fn = FUNC.exec(text)
  if (!fn) return null
  const parts = fn[1].split(/\s*[,/]\s*|\s+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  if (r === null || g === null || b === null) return null
  let a = 1
  if (parts.length === 4) {
    if (!/^\d*\.?\d+$/.test(parts[3])) return null
    a = Math.min(1, Number(parts[3]))
  }
  return { r, g, b, a }
}

/** `top` drawn over `bottom`; the result is opaque when `bottom` is. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number): number =>
    (t * top.a + b * bottom.a * (1 - top.a)) / a
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
  const seen = text.a < 1 ? compositeOver(text, bg) : text
  if (contrastRatio(seen, bg) >= CONTRAST_FLOOR) return null
  if (contrastRatio(fg, bg) >= CONTRAST_FLOOR) return palette.fg
  return contrastRatio(fg, bg) >= contrastRatio(pageBg, bg) ? palette.fg : palette.bg
}
