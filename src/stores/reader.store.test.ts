import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, PREF_RANGES, sanitizePrefs } from './reader.store'

/**
 * `localStorage` is only as trustworthy as the build that wrote it: these are
 * the shapes a stale or hand-edited `musaeum.reader` entry can hand back, all
 * of which the popover and the engine's injected CSS would otherwise consume
 * unchecked.
 */
describe('sanitizePrefs', () => {
  it('fills in everything a missing or non-object entry leaves out', () => {
    expect(sanitizePrefs(undefined)).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs('serif')).toEqual(DEFAULT_PREFS)
    expect(sanitizePrefs({})).toEqual(DEFAULT_PREFS)
  })

  it('keeps a valid value for every field', () => {
    const prefs = { typeface: 'sans', theme: 'paper', fontSize: 22, lineHeight: 1.8, margin: 96 }
    expect(sanitizePrefs(prefs)).toEqual(prefs)
  })

  it('rejects values outside the union', () => {
    expect(sanitizePrefs({ typeface: 'comic' }).typeface).toBe(DEFAULT_PREFS.typeface)
    expect(sanitizePrefs({ theme: 'sepia' }).theme).toBe(DEFAULT_PREFS.theme)
    expect(sanitizePrefs({ typeface: 7 }).typeface).toBe(DEFAULT_PREFS.typeface)
  })

  it('rejects numbers that are the wrong type, unbounded, or out of range', () => {
    expect(sanitizePrefs({ fontSize: '22' }).fontSize).toBe(DEFAULT_PREFS.fontSize)
    expect(sanitizePrefs({ fontSize: NaN }).fontSize).toBe(DEFAULT_PREFS.fontSize)
    expect(sanitizePrefs({ fontSize: Infinity }).fontSize).toBe(DEFAULT_PREFS.fontSize)
    expect(sanitizePrefs({ fontSize: PREF_RANGES.fontSize.max + 1 }).fontSize).toBe(
      DEFAULT_PREFS.fontSize
    )
    expect(sanitizePrefs({ margin: -40 }).margin).toBe(DEFAULT_PREFS.margin)
    expect(sanitizePrefs({ lineHeight: 0 }).lineHeight).toBe(DEFAULT_PREFS.lineHeight)
  })

  it('keeps the slider bounds themselves', () => {
    expect(sanitizePrefs({ fontSize: PREF_RANGES.fontSize.min }).fontSize).toBe(
      PREF_RANGES.fontSize.min
    )
    expect(sanitizePrefs({ margin: PREF_RANGES.margin.max }).margin).toBe(PREF_RANGES.margin.max)
  })

  it('falls back one field at a time rather than discarding the object', () => {
    // One stale value must not cost someone the rest of their typography
    expect(sanitizePrefs({ typeface: 'sans', theme: 'midnight', fontSize: 24 })).toEqual({
      ...DEFAULT_PREFS,
      typeface: 'sans',
      fontSize: 24
    })
  })
})
