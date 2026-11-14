import { describe, expect, it } from 'vitest'
import {
  CHIP_ATTR,
  CHIP_GLARE,
  CHIP_TEXT_FLOOR,
  CONTRAST_ATTR,
  CONTRAST_FLOOR,
  chipBackground,
  chipTextColor,
  compositeOver,
  contrastRatio,
  guardSectionContrast,
  legibleColor,
  parseCssColor,
  type ComputedSource,
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

  it('leaves fully transparent text alone — it is hidden on purpose', () => {
    expect(legibleColor({ r: 0, g: 0, b: 0, a: 0 }, hex(ink.bg), ink)).toBeNull()
  })

  it('leaves dark text on the paper page alone', () => {
    expect(legibleColor(hex('#000001'), hex(PAPER_PALETTE.bg), PAPER_PALETTE)).toBeNull()
  })

  it('leaves the book alone when the palette is not a hex pair', () => {
    expect(legibleColor(hex('#000001'), hex(ink.bg), { fg: 'var(--x)', bg: ink.bg })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// guardSectionContrast — against a hand-built fake document (no jsdom here).
// ---------------------------------------------------------------------------

interface FakeEl {
  tagName: string
  parentElement: FakeEl | null
  childNodes: { nodeType: number; textContent: string }[]
  style: ReturnType<typeof fakeStyle>
  attrs: Map<string, string>
  computed: { color: string; backgroundColor: string; fontFamily?: string }
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

function fakeStyle() {
  const props = new Map<string, { value: string; priority: string }>()
  return {
    setProperty(name: string, value: string, priority = '') {
      props.set(name, { value, priority })
    },
    getPropertyValue: (name: string) => props.get(name)?.value ?? '',
    getPropertyPriority: (name: string) => props.get(name)?.priority ?? '',
    removeProperty(name: string) {
      props.delete(name)
    }
  }
}

function el(
  tagName: string,
  text: string | null,
  computed: Partial<FakeEl['computed']> = {},
  parentElement: FakeEl | null = null
): FakeEl {
  const attrs = new Map<string, string>()
  return {
    tagName: tagName.toUpperCase(),
    parentElement,
    childNodes: text === null ? [] : [{ nodeType: 3, textContent: text }],
    style: fakeStyle(),
    attrs,
    computed: { color: 'rgb(0, 0, 1)', backgroundColor: 'rgba(0, 0, 0, 0)', ...computed },
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name)
  }
}

function fakeDoc(els: FakeEl[]): Document {
  return {
    querySelectorAll: (selector: string) =>
      selector === '*'
        ? els
        : els.filter((e) => e.attrs.has(/^\[([^\]]+)\]$/.exec(selector)?.[1] ?? ''))
  } as unknown as Document
}

const fromFake: ComputedSource = (e) => (e as unknown as FakeEl).computed
const inkPage = { bg: INK_PALETTE.bg, fg: INK_PALETTE.fg }
const paperPage = { bg: PAPER_PALETTE.bg, fg: PAPER_PALETTE.fg }

describe('guardSectionContrast', () => {
  it('gives an offending paragraph the page foreground, !important, and the marker (AC2)', () => {
    const p = el('p', 'It was a dark and stormy night')
    guardSectionContrast(fakeDoc([p]), inkPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe(INK_PALETTE.fg)
    expect(p.style.getPropertyPriority('color')).toBe('important')
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(true)
  })

  it('leaves a legible paragraph with no inline style and no marker (AC2)', () => {
    const p = el('p', 'Fine as it is', { color: 'rgb(233, 225, 210)' })
    guardSectionContrast(fakeDoc([p]), inkPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe('')
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(false)
  })

  it('does not touch dark text inside an opaque light box on a dark page (AC3)', () => {
    const box = el('div', null, { backgroundColor: 'rgb(243, 236, 224)' })
    const p = el('p', 'A callout', {}, box)
    guardSectionContrast(fakeDoc([box, p]), inkPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe('')
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(false)
  })

  it('gives light text on a light box the better of fg/bg (AC4)', () => {
    const box = el('div', null, { backgroundColor: 'rgb(243, 236, 224)' })
    const p = el('p', 'Washed out', { color: 'rgb(233, 225, 210)' }, box)
    guardSectionContrast(fakeDoc([box, p]), inkPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe(INK_PALETTE.bg)
  })

  it('clears the previous overrides when re-run under a light palette (AC5)', () => {
    const p = el('p', 'Hard-coded black')
    const doc = fakeDoc([p])
    guardSectionContrast(doc, inkPage, fromFake)
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(true)
    guardSectionContrast(doc, paperPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe('')
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(false)
  })

  it('restores an inline color the book already had, with its priority', () => {
    const p = el('p', 'Inline red')
    p.style.setProperty('color', 'red', '')
    const doc = fakeDoc([p])
    guardSectionContrast(doc, inkPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe(INK_PALETTE.fg)
    guardSectionContrast(doc, paperPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe('red')
    expect(p.style.getPropertyPriority('color')).toBe('')
  })

  it('skips an element whose computed style throws and still fixes its sibling (AC6)', () => {
    const bad = el('p', 'Throws')
    const good = el('p', 'Fine to fix')
    const computed: ComputedSource = (e) => {
      if (e === (bad as unknown)) throw new Error('detached')
      return fromFake(e)
    }
    expect(() => guardSectionContrast(fakeDoc([bad, good]), inkPage, computed)).not.toThrow()
    expect(bad.attrs.has(CONTRAST_ATTR)).toBe(false)
    expect(good.style.getPropertyValue('color')).toBe(INK_PALETTE.fg)
  })

  it('does not paint over transparent text (an OCR layer, a clipped heading)', () => {
    const p = el('p', 'Hidden on purpose', { color: 'rgba(0, 0, 0, 0)' })
    guardSectionContrast(fakeDoc([p]), inkPage, fromFake)
    expect(p.style.getPropertyValue('color')).toBe('')
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(false)
  })

  it('reads every color before it writes any, so a large section recalculates style once', () => {
    const a = el('p', 'One')
    const b = el('p', 'Two')
    const log: string[] = []
    const computed: ComputedSource = (e) => {
      log.push(e === (a as unknown) ? 'read-a' : 'read-b')
      return fromFake(e)
    }
    const seen = (el: FakeEl, tag: string) => {
      const set = el.style.setProperty
      el.style.setProperty = (n: string, v: string, p?: string) => {
        log.push(tag)
        set(n, v, p)
      }
    }
    seen(a, 'write-a')
    seen(b, 'write-b')
    guardSectionContrast(fakeDoc([a, b]), inkPage, computed)
    expect(log.lastIndexOf('read-a')).toBeLessThan(log.indexOf('write-a'))
    expect(log.lastIndexOf('read-b')).toBeLessThan(log.indexOf('write-a'))
  })

  it('skips an element whose color cannot be parsed (AC6)', () => {
    const p = el('p', 'Weird', { color: 'color(display-p3 0 0 0)' })
    guardSectionContrast(fakeDoc([p]), inkPage, fromFake)
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(false)
  })

  it('does not examine whitespace-only text or anything under svg/style', () => {
    const blank = el('p', '   \n  ')
    const svg = el('svg', null)
    const inSvg = el('tspan', 'In a figure', {}, svg)
    const style = el('style', 'p { color: black }')
    guardSectionContrast(fakeDoc([blank, svg, inSvg, style]), inkPage, fromFake)
    for (const e of [blank, svg, inSvg, style]) expect(e.attrs.has(CONTRAST_ATTR)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Code chips — a bright box behind monospace text on a dark page
// ---------------------------------------------------------------------------

describe('chipBackground', () => {
  const ink = INK_PALETTE
  const page = hex(ink.bg)
  const MONO = '"Courier New", monospace'
  const cream = hex('#f0eee6')

  it('quiets a bright monospace chip on the dark page into a tint of the page', () => {
    const tint = chipBackground(cream, MONO, page, ink)
    expect(tint).toMatch(/^#[0-9a-f]{6}$/)
    expect(contrastRatio(hex(tint ?? ''), page)).toBeLessThan(CHIP_GLARE)
  })

  it('leaves a bright box that is not monospace alone — a callout is deliberate (AC3)', () => {
    expect(chipBackground(cream, 'Georgia, serif', page, ink)).toBeNull()
  })

  it('leaves the same chip alone on the paper page, where it is not bright against it', () => {
    expect(chipBackground(cream, MONO, hex(PAPER_PALETTE.bg), PAPER_PALETTE)).toBeNull()
  })

  it('leaves a monospace element with no background of its own alone', () => {
    expect(chipBackground(null, MONO, page, ink)).toBeNull()
    expect(chipBackground({ r: 255, g: 255, b: 255, a: 0.2 }, MONO, page, ink)).toBeNull()
  })

  it("leaves a chip inside a light box alone — the box is the book's choice", () => {
    expect(chipBackground(cream, MONO, hex('#f3ece0'), ink)).toBeNull()
  })

  it('leaves the book alone when the palette is not a hex pair', () => {
    expect(chipBackground(cream, MONO, page, { fg: 'var(--x)', bg: ink.bg })).toBeNull()
  })

  it('recognizes the generic monospace family and the common named ones', () => {
    for (const family of ['monospace', 'ui-monospace, Menlo', 'Consolas', '"SF Mono", Monaco']) {
      expect(chipBackground(cream, family, page, ink)).not.toBeNull()
    }
  })
})

describe('guardSectionContrast — code chips', () => {
  const MONO = '"Courier New", monospace'
  // What the book's stylesheet gives `.class_s1JC-0`, read off a real epub.
  const chipStyle = {
    color: 'rgb(122, 81, 217)',
    backgroundColor: 'rgb(240, 238, 230)',
    fontFamily: MONO
  }

  it('replaces a bright chip background with a quiet tint, !important, and the marker', () => {
    const chip = el('span', '.claude/agents/', chipStyle)
    guardSectionContrast(fakeDoc([chip]), inkPage, fromFake)
    const bg = chip.style.getPropertyValue('background-color')
    expect(bg).toMatch(/^#[0-9a-f]{6}$/)
    expect(chip.style.getPropertyPriority('background-color')).toBe('important')
    expect(chip.attrs.has(CHIP_ATTR)).toBe(true)
    expect(contrastRatio(hex(bg), hex(INK_PALETTE.bg))).toBeLessThan(CHIP_GLARE)
  })

  it('lifts the chip text to a comfortable contrast against the tint, keeping its hue', () => {
    const chip = el('span', '.claude/agents/', chipStyle)
    guardSectionContrast(fakeDoc([chip]), inkPage, fromFake)
    const tint = hex(chip.style.getPropertyValue('background-color'))
    const text = hex(chip.style.getPropertyValue('color'))
    expect(contrastRatio(text, tint)).toBeGreaterThanOrEqual(CHIP_TEXT_FLOOR)
    // still the book's purple, only lighter: blue leads, and it is not the page foreground
    expect(text.b).toBeGreaterThan(text.g)
    expect(text.b).toBeGreaterThan(text.r)
    expect(chip.style.getPropertyValue('color')).not.toBe(INK_PALETTE.fg)
  })

  it('holds text outside a chip to the ordinary floor (a dim grey is left alone)', () => {
    const p = el('p', 'A muted caption', { color: 'rgb(110, 110, 110)' })
    guardSectionContrast(fakeDoc([p]), inkPage, fromFake)
    expect(p.attrs.has(CONTRAST_ATTR)).toBe(false)
  })

  it('judges dark text inside a restyled chip against the tint, not the old bright box', () => {
    const block = el('pre', null, {
      color: 'rgb(20, 20, 19)',
      backgroundColor: 'rgb(240, 238, 230)',
      fontFamily: MONO
    })
    const line = el('span', 'npm install', { color: 'rgb(20, 20, 19)', fontFamily: MONO }, block)
    guardSectionContrast(fakeDoc([block, line]), inkPage, fromFake)
    expect(line.style.getPropertyValue('color')).toBe(INK_PALETTE.fg)
  })

  it('does not touch a chip on the paper page', () => {
    const chip = el('span', 'code', chipStyle)
    guardSectionContrast(fakeDoc([chip]), paperPage, fromFake)
    expect(chip.attrs.has(CHIP_ATTR)).toBe(false)
    expect(chip.style.getPropertyValue('background-color')).toBe('')
  })

  it('does not touch a bright callout that is not monospace (AC3)', () => {
    const box = el('div', null, { backgroundColor: 'rgb(240, 238, 230)', fontFamily: 'Georgia' })
    const p = el('p', 'A callout', { fontFamily: 'Georgia' }, box)
    guardSectionContrast(fakeDoc([box, p]), inkPage, fromFake)
    expect(box.attrs.has(CHIP_ATTR)).toBe(false)
    expect(box.style.getPropertyValue('background-color')).toBe('')
  })

  it('gives the book its own chip back when re-run under the paper page', () => {
    const chip = el('span', 'code', chipStyle)
    const doc = fakeDoc([chip])
    guardSectionContrast(doc, inkPage, fromFake)
    expect(chip.attrs.has(CHIP_ATTR)).toBe(true)
    guardSectionContrast(doc, paperPage, fromFake)
    expect(chip.style.getPropertyValue('background-color')).toBe('')
    expect(chip.attrs.has(CHIP_ATTR)).toBe(false)
  })

  it('restores an inline background the book already had, with its priority', () => {
    const chip = el('span', 'code', chipStyle)
    chip.style.setProperty('background-color', '#f0eee6', '')
    const doc = fakeDoc([chip])
    guardSectionContrast(doc, inkPage, fromFake)
    expect(chip.style.getPropertyValue('background-color')).not.toBe('#f0eee6')
    guardSectionContrast(doc, paperPage, fromFake)
    expect(chip.style.getPropertyValue('background-color')).toBe('#f0eee6')
    expect(chip.style.getPropertyPriority('background-color')).toBe('')
  })

  it('reads every color before it writes any, chips included', () => {
    const chip = el('span', 'code', chipStyle)
    const p = el('p', 'Body')
    const log: string[] = []
    const computed: ComputedSource = (e) => {
      log.push('read')
      return fromFake(e)
    }
    const set = chip.style.setProperty
    chip.style.setProperty = (n: string, v: string, pr?: string) => {
      log.push('write')
      set(n, v, pr)
    }
    guardSectionContrast(fakeDoc([chip, p]), inkPage, computed)
    expect(log.lastIndexOf('read')).toBeLessThan(log.indexOf('write'))
  })

  it('ignores font information it was not given (an older stub, an unreadable style)', () => {
    const chip = el('span', 'code', { backgroundColor: 'rgb(240, 238, 230)' })
    guardSectionContrast(fakeDoc([chip]), inkPage, fromFake)
    expect(chip.attrs.has(CHIP_ATTR)).toBe(false)
  })
})

describe('chipTextColor', () => {
  const ink = INK_PALETTE
  const tint = hex('#25221d')
  const purple = hex('#7a51d9')

  it('is null when the text already reads comfortably', () => {
    expect(chipTextColor(hex(ink.fg), tint, ink)).toBeNull()
  })

  it('lightens a dim text toward the foreground until it clears the chip floor', () => {
    const next = chipTextColor(purple, tint, ink)
    expect(next).toMatch(/^#[0-9a-f]{6}$/)
    const out = hex(next ?? '')
    expect(contrastRatio(out, tint)).toBeGreaterThanOrEqual(CHIP_TEXT_FLOOR)
    expect(contrastRatio(out, tint)).toBeLessThan(CHIP_TEXT_FLOOR + 0.5)
  })

  it('does not go past what it needs: the original hue survives', () => {
    const out = hex(chipTextColor(purple, tint, ink) ?? '')
    expect(out.b).toBeGreaterThan(out.g)
  })

  it('leaves the book alone when the palette is not a hex pair', () => {
    expect(chipTextColor(purple, tint, { fg: 'var(--x)', bg: ink.bg })).toBeNull()
  })

  it('keeps the chip floor above the ordinary one', () => {
    expect(CHIP_TEXT_FLOOR).toBeGreaterThan(CONTRAST_FLOOR)
  })
})
