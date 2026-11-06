import { describe, expect, it } from 'vitest'
import {
  CONTRAST_FLOOR,
  compositeOver,
  contrastRatio,
  legibleColor,
  parseCssColor,
  type Rgba
} from './reader-contrast'
import { INK_PALETTE, PAPER_PALETTE } from './reader-palette'

const hex = (value: string): Rgba => {
  const c = parseCssColor(value)
  if (!c) throw new Error(`bad fixture ${value}`)
  return c
}

describe('contrastRatio (AC1)', () => {
  it('is 21 for black on white, in either order', () => {
    expect(contrastRatio(hex('#000000'), hex('#ffffff'))).toBeCloseTo(21, 1)
    expect(contrastRatio(hex('#ffffff'), hex('#000000'))).toBeCloseTo(21, 1)
  })

  it('is 1 for equal colors', () => {
    expect(contrastRatio(hex('#14110d'), hex('#14110d'))).toBeCloseTo(1, 5)
  })

  it('puts InDesign #000001 on the ink page below the floor', () => {
    expect(contrastRatio(hex('#000001'), hex(INK_PALETTE.bg))).toBeLessThan(CONTRAST_FLOOR)
  })

  it('keeps the floor at 3', () => {
    expect(CONTRAST_FLOOR).toBe(3)
  })
})

describe('parseCssColor', () => {
  it('reads a computed rgba() with a fractional alpha', () => {
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
  })

  it('reads rgb() in comma and space syntax', () => {
    expect(parseCssColor('rgb(12, 34, 56)')).toEqual({ r: 12, g: 34, b: 56, a: 1 })
    expect(parseCssColor('rgb(12 34 56)')).toEqual({ r: 12, g: 34, b: 56, a: 1 })
  })

  it('reads #rrggbb', () => {
    expect(parseCssColor('#14110d')).toEqual({ r: 20, g: 17, b: 13, a: 1 })
  })

  it('is null for transparent and for garbage', () => {
    expect(parseCssColor('transparent')).toBeNull()
    expect(parseCssColor('garbage')).toBeNull()
    expect(parseCssColor('')).toBeNull()
  })
})

describe('compositeOver', () => {
  it('returns the top color when it is opaque', () => {
    expect(compositeOver(hex('#ffffff'), hex('#000000'))).toEqual({ r: 255, g: 255, b: 255, a: 1 })
  })

  it('mixes a half-transparent white over black to mid grey', () => {
    const out = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, hex('#000000'))
    expect(out.r).toBeCloseTo(127.5, 1)
    expect(out.a).toBe(1)
  })
})

describe('legibleColor', () => {
  const ink = INK_PALETTE

  it('leaves legible text alone (null)', () => {
    expect(legibleColor(hex('#e9e1d2'), hex(ink.bg), ink)).toBeNull()
  })

  it('gives an offender the page foreground (AC2)', () => {
    expect(legibleColor(hex('#000001'), hex(ink.bg), ink)).toBe(ink.fg)
  })

  it('picks the better of fg/bg when fg also fails locally (AC4)', () => {
    expect(legibleColor(hex('#e9e1d2'), hex('#f3ece0'), ink)).toBe(ink.bg)
  })

  it('treats a nearly-transparent text color as an offender, composited first', () => {
    expect(legibleColor({ r: 233, g: 225, b: 210, a: 0.1 }, hex(ink.bg), ink)).toBe(ink.fg)
  })

  it('leaves dark text on the paper page alone', () => {
    expect(legibleColor(hex('#000001'), hex(PAPER_PALETTE.bg), PAPER_PALETTE)).toBeNull()
  })

  it('leaves the book alone when the palette is not a hex pair', () => {
    expect(legibleColor(hex('#000001'), hex(ink.bg), { fg: 'var(--x)', bg: ink.bg })).toBeNull()
  })
})
