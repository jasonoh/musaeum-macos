import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { InkStep, ThemeIr } from '@shared/theme.types'
import { chroma, hexToRgb, hueDelta, lstar } from './color'
import {
  base16ToIr,
  deriveTheme,
  loadThemeFile,
  loadThemeText,
  parseBase16,
  parseItermcolors
} from './index'

/**
 * The two provider adapters, against the files the app actually ships.
 *
 * Paths resolve from `process.cwd()` — the suite runs from the repo root, as the
 * other main-process suites do.
 */

const BUILTIN = join(process.cwd(), 'electron', 'main', 'services', 'theme', 'builtin')
const ITERM_FIXTURES = join(process.cwd(), 'test', 'fixtures', 'theme')

const GRUVBOX_YAML = join(BUILTIN, 'gruvbox-dark-hard.yaml')
const NORD_YAML = join(BUILTIN, 'nord.yaml')
const GRUVBOX_ITERM = join(ITERM_FIXTURES, 'gruvbox.itermcolors')

function loadIr(path: string): ThemeIr {
  const loaded = loadThemeFile(path)
  if (!loaded.ok) throw new Error(`${path} did not load: ${loaded.reason}`)
  return loaded.ir
}

/**
 * AC2.5. base16 already carries the semantics the IR wants, so this adapter is a
 * straight read: base00 -> bg, base05 -> fg, base09 -> accent_hint, and
 * base01/02/03/04 -> bg2/bg3/border/muted with no notes.
 */
describe('AC2.5 — adaptation is lossless where base16 has the semantics', () => {
  it('reads base00..0F straight into the IR', () => {
    expect(loadIr(GRUVBOX_YAML)).toEqual({
      name: 'Gruvbox dark, hard',
      author: 'Dawid Kurek (dawikur@gmail.com), morhetz (https://github.com/morhetz/gruvbox)',
      variant: 'dark',
      source: 'base16',
      bg: '#1d2021',
      bg2: '#3c3836',
      bg3: '#504945',
      border: '#665c54',
      muted: '#bdae93',
      fg: '#d5c4a1',
      fg_bright: '#fbf1c7',
      accents: {
        red: '#fb4934',
        orange: '#fe8019',
        yellow: '#fabd2f',
        green: '#b8bb26',
        cyan: '#8ec07c',
        blue: '#83a598',
        purple: '#d3869b',
        brown: '#d65d0e'
      },
      accent_hint: '#fe8019',
      notes: []
    })
  })

  it('does not re-derive the surface stops the file already names', () => {
    // The mutation AC2.5 names: taking bg2/bg3 from the derived ladder instead of
    // reading base01/base02. Every one of the four disagrees with the ladder.
    const ir = loadIr(GRUVBOX_YAML)
    const derived = deriveTheme(ir)
    if (!derived.ok) throw new Error(`rejected: ${derived.reason.role}`)
    expect(ir.bg2).toBe('#3c3836')
    expect(ir.bg2).not.toBe(derived.tokens.ink['900'])
    expect(ir.bg3).not.toBe(derived.tokens.ink['850'])
    expect(ir.border).not.toBe(derived.tokens.ink['800'])
    expect(ir.muted).not.toBe(derived.tokens.ink['700'])
  })

  it('lowercases the file’s hex and reads its metadata', () => {
    // nord.yaml spells its palette in uppercase (`base00: "#2E3440"`)
    const ir = loadIr(NORD_YAML)
    expect(ir.bg).toBe('#2e3440')
    expect(ir.accents.green).toBe('#a3be8c')
    expect(ir.name).toBe('Nord')
    expect(ir.author).toBe('arcticicestudio')
    expect(ir.variant).toBe('dark')
    expect(ir.notes).toEqual([])
  })

  it('builds the IR in two steps, so slice 4 can re-read a pasted scheme', () => {
    const text = readFileSync(GRUVBOX_YAML, 'utf8')
    const parsed = parseBase16(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable: asserted above')
    expect(parsed.scheme.meta.name).toBe('Gruvbox dark, hard')
    expect(parsed.scheme.palette.base00).toBe('#1d2021')
    expect(base16ToIr(parsed.scheme)).toEqual(loadIr(GRUVBOX_YAML))
  })

  it('reads a scheme that names no variant as dark, as the prototype does', () => {
    const text = readFileSync(GRUVBOX_YAML, 'utf8').replace(/^variant:.*$/m, '')
    const loaded = loadThemeText('gruvbox-dark-hard.yaml', text)
    if (!loaded.ok) throw new Error(loaded.reason)
    expect(loaded.ir.variant).toBe('dark')
  })
})

/**
 * AC2.4. Terminal files carry no base01–03, so the surface ramp is reconstructed
 * from whatever greys the palette ships — and only greys in the background's own
 * hue family may stand in for surfaces.
 *
 * Measured, and it matters for how these assertions are written: the criterion as
 * drafted ("every derived stop has `hue_delta(stop, bg) < 0.61`") does **not**
 * hold for the prototype's output on this fixture. Six of the seven stops measure
 * 1.29–2.47 against their own canvas, because the hue clause of the filter is
 * bypassed when the background is itself near-neutral (`chroma(bg) = 0.0049 <
 * 0.01`) and the hue angle of a near-grey is unstable — the stops carry chroma
 * 0.002–0.028, i.e. they are greys whose "hue" is numerical noise. The property
 * that actually delivers "no green sidebar" is the one asserted below: the filter
 * excludes every chromatic ANSI slot up front, and the ladder it builds stays grey.
 */
describe('AC2.4 — the iTerm grey filter does its job', () => {
  it('excludes every chromatic ANSI slot under the filter’s own predicate, bypass included', () => {
    const ir = loadIr(GRUVBOX_ITERM)
    const bg = hexToRgb(ir.bg)
    // The filter's own predicate, transcribed from `itermcolors.ts:210-211`: a slot is a
    // grey when its chroma is under 0.035 *and* it sits in the canvas's hue family —
    // *unless* the canvas is itself near-neutral, in which case the hue half is bypassed,
    // because a near-grey's hue angle is numerical noise. The bypass is not decoration
    // here: this canvas's chroma is 0.0049, so it is live, and the two forms of the
    // predicate are **not** the same statement on this fixture — measured, Ansi 7
    // (#a89984, chroma 0.0346, hue_delta 2.5022) and Ansi 8 (#928374, chroma 0.0286,
    // hue_delta 2.6601) are *admitted* by the filter and are exactly the two stops the
    // ladder is built from, while a predicate without the bypass calls both excluded.
    // Which is why the expression below is written out with the bypass in it.
    expect(chroma(bg)).toBeLessThan(0.01)
    const bypass = chroma(bg) < 0.01
    const excluded = (hex: string): boolean => {
      const tone = hexToRgb(hex)
      return chroma(tone) >= 0.035 || (!bypass && hueDelta(tone, bg) >= 0.61)
    }

    // The candidates a luminance sort would have had to choose from: none of the
    // palette's accent slots can stand in for a surface, under either clause. The
    // set is pinned because the loop below iterates it — an adapter shipping an
    // empty `accents` object would otherwise run zero assertions and pass.
    const candidates = Object.entries(ir.accents)
    expect(candidates).toHaveLength(8)
    for (const [slot, hex] of candidates) {
      expect({ slot, excluded: excluded(hex) }).toEqual({ slot, excluded: true })
    }
    // And the other direction, which is the half this case used to omit: the slots the
    // filter *admitted*. Asserting only the excluded set cannot tell the bypass apart
    // from a predicate with no hue clause at all, and it is the admitted set that builds
    // the ladder.
    for (const hex of [ir.bg, ir.bg2, ir.bg3, ir.border]) {
      expect({ hex, excluded: excluded(hex) }).toEqual({ hex, excluded: false })
    }
    // Which is why the ramp is inferred from three greys and no more
    expect(ir.notes).toEqual(['ramp inferred from 3 greys; no base01-03 in source'])

    // What this case does *not* decide, so the name is not read as more than it is: it
    // transcribes the predicate rather than observing the filter. Deleting the hue clause
    // from `itermcolors.ts` leaves every assertion above unchanged — the bypass makes the
    // hue half moot on this fixture — and deleting the chroma clause leaves this
    // expression, which is the test's own, unchanged as well. The chroma half is decided
    // by observing the filter (the luminance-sort witness in this block, and the IR
    // equality above); the hue half by the synthetic file in AC2.4(a) below.
  })

  it('derives a ladder that stays a grey ladder, rising from the canvas', () => {
    const loaded = loadThemeFile(GRUVBOX_ITERM)
    if (!loaded.ok) throw new Error(loaded.reason)
    const derived = deriveTheme(loaded.ir)
    if (!derived.ok) throw new Error(`rejected: ${derived.reason.role}`)

    // The stops in the prototype's own order: JS reorders integer-like keys
    // ascending, so `Object.entries` would walk the ladder backwards.
    const stops: InkStep[] = ['950', '900', '850', '800', '700', '600', '500']
    let previous = -1
    for (const stop of stops) {
      const tone = hexToRgb(derived.tokens.ink[stop])
      // Below the threshold the filter itself uses to call something a grey: no
      // stop is a green, a teal, or anything else with a hue to speak of.
      expect({ stop, grey: chroma(tone) < 0.035 }).toEqual({ stop, grey: true })
      // And the ladder only ever climbs, from the canvas toward the palette's own
      // border tone — the direction is the point of it.
      expect({ stop, rises: lstar(tone) > previous }).toEqual({ stop, rises: true })
      previous = lstar(tone)
    }
  })

  it('infers the ramp from the palette’s own greys', () => {
    // gruvbox ships exactly three greys in its background's family: the canvas, Ansi
    // 8 and Ansi 7. Two of them are interior, and the prototype's median and upper
    // pick are then the same element — so bg3 and border coincide here on purpose.
    expect(loadIr(GRUVBOX_ITERM)).toEqual({
      name: 'gruvbox',
      author: '',
      variant: 'dark',
      source: 'itermcolors',
      bg: '#1d2021',
      bg2: '#928374',
      bg3: '#a89984',
      border: '#a89984',
      muted: '#958e77',
      fg: '#ebdbb2',
      fg_bright: '#ebdbb2',
      accents: {
        red: '#cc241d',
        orange: '#fabd2f',
        yellow: '#d79921',
        green: '#98971a',
        cyan: '#689d6a',
        blue: '#458588',
        purple: '#b16286',
        brown: '#fb4934'
      },
      accent_hint: '#fabd2f',
      notes: ['ramp inferred from 3 greys; no base01-03 in source']
    })
  })

  it('would have pulled a green out of the ANSI slots with a luminance sort', () => {
    // The mutation AC2.4 names, as a witness rather than a comment: gruvbox's green
    // (Ansi 2) sits inside the bg->fg luminance window, so a naive sort of the slots
    // has it available for bg2 — a warm scheme with a green sidebar. It is excluded
    // because it is far outside the background's own hue and carries real chroma.
    const ir = loadIr(GRUVBOX_ITERM)
    const bg = hexToRgb(ir.bg)
    const green = hexToRgb(ir.accents.green)
    const lo = Math.min(lstar(bg), lstar(hexToRgb(ir.fg)))
    const hi = Math.max(lstar(bg), lstar(hexToRgb(ir.fg)))
    expect(lstar(green)).toBeGreaterThan(lo)
    expect(lstar(green)).toBeLessThan(hi)
    expect(hueDelta(green, bg)).toBeGreaterThanOrEqual(0.61)
    expect(chroma(green)).toBeGreaterThanOrEqual(0.035)
  })
})

/**
 * A `.itermcolors` document built in the test — no fixture file, nothing vendored —
 * in the shape iTerm writes: a `key` naming a colour, then a `dict` carrying
 * Red/Green/Blue as `real`s.
 */
function itermFile(slots: Record<string, string>): string {
  const entry = (hex: string): string => {
    const [r, g, b] = hexToRgb(hex)
    return (
      '\t\t<dict>\n' +
      `\t\t\t<key>Red Component</key>\n\t\t\t<real>${r}</real>\n` +
      `\t\t\t<key>Green Component</key>\n\t\t\t<real>${g}</real>\n` +
      `\t\t\t<key>Blue Component</key>\n\t\t\t<real>${b}</real>\n` +
      '\t\t\t<key>Alpha Component</key>\n\t\t\t<real>1</real>\n' +
      '\t\t</dict>\n'
    )
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n\t<dict>\n' +
    Object.entries(slots)
      .map(([key, hex]) => `\t\t<key>${key}</key>\n${entry(hex)}`)
      .join('') +
    '\t</dict>\n</plist>\n'
  )
}

/**
 * AC2.4(a), the second fixture. The clause "every derived stop has
 * `hue_delta(stop, bg) < 0.61`" cannot be decided on gruvbox — its canvas chroma
 * (0.0049) is under the filter's own 0.01 bypass, so the hue clause never engages
 * there — and it cannot be decided on nord either, where it holds but changes
 * nothing: every slot the filter rejects there is already rejected for chroma, so
 * dropping the hue clause leaves nord's ladder identical. So the clause gets a
 * canvas that carries real chroma, and a slot that only the hue clause can refuse.
 */
describe('AC2.4(a) — the hue clause, on a canvas that carries chroma', () => {
  const CANVAS = '#1b2b3a'
  const FOREGROUND = '#e8e8e8'
  const GREY_LO = '#3a4b57'
  const GREY_HI = '#506070'
  /** A near-grey off the canvas's own hue, at a luminance a ladder sort would take. */
  const OFF_HUE = '#5a4a3a'
  const SYNTHETIC = itermFile({
    'Ansi 0 Color': CANVAS,
    'Ansi 1 Color': '#c14a4a',
    'Ansi 2 Color': '#6a9a3a',
    'Ansi 3 Color': '#d0a030',
    'Ansi 4 Color': '#5070c0',
    'Ansi 5 Color': '#9a5ac0',
    'Ansi 6 Color': '#3a9a9a',
    'Ansi 7 Color': GREY_HI,
    'Ansi 8 Color': GREY_LO,
    'Ansi 9 Color': '#e07a5a',
    'Ansi 10 Color': '#8aba5a',
    'Ansi 11 Color': '#e8c060',
    'Ansi 12 Color': '#7090e0',
    'Ansi 13 Color': '#b07ae0',
    'Ansi 14 Color': '#5acaca',
    'Ansi 15 Color': OFF_HUE,
    'Background Color': CANVAS,
    'Foreground Color': FOREGROUND
  })

  it('measures the canvas, the greys and the off-hue slot', () => {
    // The three properties the witness rests on, so a reader does not have to take
    // the filter's behaviour on faith.
    const bg = hexToRgb(CANVAS)
    // The bypass is not in play: this canvas is not near-neutral.
    expect(chroma(bg)).toBeGreaterThanOrEqual(0.01)
    const off = hexToRgb(OFF_HUE)
    expect(chroma(off)).toBeLessThan(0.035)
    expect(hueDelta(off, bg)).toBeGreaterThanOrEqual(0.61)
    // And it sits strictly inside the canvas -> foreground window the ladder sorts
    // over, so a sort that ignored hue would take it for a surface tone.
    const lo = Math.min(lstar(bg), lstar(hexToRgb(FOREGROUND)))
    const hi = Math.max(lstar(bg), lstar(hexToRgb(FOREGROUND)))
    expect(lstar(off)).toBeGreaterThan(lo)
    expect(lstar(off)).toBeLessThan(hi)
    // Specifically: between the two in-family greys, so it would land in the middle
    // of the ladder rather than at one end.
    expect(lstar(off)).toBeGreaterThan(lstar(hexToRgb(GREY_LO)))
    expect(lstar(off)).toBeLessThan(lstar(hexToRgb(GREY_HI)))
  })

  it('refuses to build the ladder out of a near-grey off the canvas’s hue', () => {
    // The separating witness. With the real filter the ladder is the two in-family
    // greys; drop the hue clause from the filter and the off-hue slot is admitted,
    // `bg3` becomes `#5a4a3a` and the note counts three greys (measured against a
    // byte-identical copy with that one clause removed).
    const loaded = loadThemeText('synthetic.itermcolors', SYNTHETIC)
    if (!loaded.ok) throw new Error(loaded.reason)
    expect(loaded.ir.bg2).toBe(GREY_LO)
    expect(loaded.ir.bg3).toBe(GREY_HI)
    expect(loaded.ir.border).toBe(GREY_HI)
    expect(loaded.ir.notes).toEqual(['ramp inferred from 2 greys; no base01-03 in source'])
  })

  it('holds on the iTerm nord fixture too, as a property and not a discriminator', () => {
    // A pin, and the reason it is only a pin: nord satisfies the clause (measured
    // 0.000–0.003 across the seven stops), but it satisfies it with the hue clause
    // deleted as well, so this cannot tell the two filters apart. It is here so a
    // reader does not have to assume the clause holds on the fixture the criterion
    // was first written for; the case above is the discriminator.
    const loaded = loadThemeFile(join(ITERM_FIXTURES, 'nord.itermcolors'))
    if (!loaded.ok) throw new Error(loaded.reason)
    const derived = deriveTheme(loaded.ir)
    if (!derived.ok) throw new Error(`rejected: ${derived.reason.role}`)
    const bg = hexToRgb(loaded.ir.bg)
    const stops: InkStep[] = ['950', '900', '850', '800', '700', '600', '500']
    for (const stop of stops) {
      expect({ stop, under: hueDelta(hexToRgb(derived.tokens.ink[stop]), bg) < 0.61 }).toEqual({
        stop,
        under: true
      })
    }
  })
})

/**
 * AC2.6. Every way a provider file can be wrong ends in a value, never a throw:
 * an unparseable file reports a reason, and the app keeps the palette it had.
 */
describe('AC2.6 — a bad file is reported, never thrown', () => {
  it('rejects a truncated .itermcolors', () => {
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    // Truncated from the real bytes — no second fixture file
    const truncated = text.slice(0, Math.floor(text.length / 2))
    const loaded = loadThemeText('gruvbox.itermcolors', truncated)
    expect(loaded).toEqual({
      ok: false,
      reason: 'not a well-formed plist (truncated, unbalanced or not XML)'
    })
  })

  it('names the ANSI slot it cannot find', () => {
    // The prototype only ever saw complete documents (plistlib gave it no choice);
    // this scanner can see a missing slot, so it has to name it rather than
    // synthesise a colour for it.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    const without = text.replace(/<key>Ansi 5 Color<\/key>\s*<dict>[\s\S]*?<\/dict>/, '')
    expect(without).not.toContain('Ansi 5 Color')
    expect(parseItermcolors(without, 'gruvbox')).toEqual({
      ok: false,
      reason: 'itermcolors file is missing Ansi 5 Color'
    })
  })

  it('rejects a component it cannot read as a number rather than coercing it', () => {
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    const broken = text.replace(
      /(<key>Ansi 1 Color<\/key>[\s\S]*?<key>Red Component<\/key>\s*<real>)[\d.]+(<\/real>)/,
      '$1not-a-number$2'
    )
    expect(broken).not.toBe(text)
    expect(parseItermcolors(broken, 'gruvbox')).toEqual({
      ok: false,
      reason: 'itermcolors file is missing Ansi 1 Color'
    })
  })

  it('rejects a base16 scheme missing base0A', () => {
    const text = readFileSync(GRUVBOX_YAML, 'utf8')
    const crippled = text.replace(/^\s*base0A:.*$/m, '')
    expect(crippled).not.toBe(text)
    expect(loadThemeText('gruvbox-dark-hard.yaml', crippled)).toEqual({
      ok: false,
      reason: 'base16 scheme missing base0A'
    })
  })

  it('rejects a plain-text file with an unknown extension', () => {
    expect(loadThemeText('palette.txt', 'these are notes, not a theme')).toEqual({
      ok: false,
      reason: 'Unsupported theme file type: .txt — expected .yaml, .yml or .itermcolors'
    })
  })

  it('reports an unreadable path', () => {
    const missing = join(process.cwd(), 'sidecar', 'no-such-theme.yaml')
    const loaded = loadThemeFile(missing)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) throw new Error('unreachable: asserted above')
    expect(loaded.reason).toContain(missing)
  })

  it('rejects an extra closing tag after the root dict', () => {
    // The guard the reviewer found unpinned: without it the extra `</dict>` pops a
    // frame that is not there, and a scanner that skipped it instead would read this
    // document as if it were well-formed.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    expect(parseItermcolors(`${text}</dict>`, 'gruvbox')).toEqual({
      ok: false,
      reason: 'not a well-formed plist (truncated, unbalanced or not XML)'
    })
  })

  it('rejects a container left open after the root dict has closed', () => {
    // This is the input the stack-length guard at the end of the scan exists for: an
    // unbalanced extra `<dict>` leaves a frame open when the document ends.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    expect(parseItermcolors(`${text}<dict>`, 'gruvbox')).toEqual({
      ok: false,
      reason: 'not a well-formed plist (truncated, unbalanced or not XML)'
    })
  })

  it('rejects a balanced container after the root dict, rather than adopting it', () => {
    // The annex's second constructed input. It rejects, but not for the reason the
    // annex gave: the stack *is* empty at the end of the scan, so the final
    // stack-length guard never fires — the trailing `dict` is simply the last thing
    // closed, which makes it the root. The document then reads as an empty dict and
    // every slot is missing.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    const loaded = parseItermcolors(`${text}<dict></dict>`, 'gruvbox')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) throw new Error('unreachable: asserted above')
    expect(loaded.reason).toContain('itermcolors file is missing Ansi 0 Color')
  })

  it('rejects a document whose root is an array, not a dict', () => {
    // `plistlib` would hand the prototype a list here and the prototype would crash;
    // reading it as a dict — which the scanner used to do, since it pushed a frame
    // for `<array>` exactly as for `<dict>` — was a false positive.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    const arrayRoot = text
      .replace('<dict>', '<array>')
      .replace(/<\/dict>(\s*)<\/plist>/, '</array>$1</plist>')
    expect(arrayRoot).not.toBe(text)
    expect(parseItermcolors(arrayRoot, 'gruvbox')).toEqual({
      ok: false,
      reason: 'not a well-formed plist (truncated, unbalanced or not XML)'
    })
  })

  it('rejects a component written as a string, where the reference would read it', () => {
    // A D9-sanctioned divergence from `derive.py`, recorded rather than assumed:
    // `plistlib` returns this component as a `str` and the prototype's `float()`
    // converts it, so the prototype derives happily from this file. The scanner reads
    // `real`/`integer` only, so the slot reports as unreadable — fail closed, which
    // is D9's direction.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    const stringy = text.replace(
      /(<key>Ansi 1 Color<\/key>[\s\S]*?<key>Red Component<\/key>\s*)<real>([\d.]+)<\/real>/,
      '$1<string>$2</string>'
    )
    expect(stringy).not.toBe(text)
    expect(parseItermcolors(stringy, 'gruvbox')).toEqual({
      ok: false,
      reason: 'itermcolors file is missing Ansi 1 Color'
    })
  })

  it('rejects a file with no Background Color, where the reference substitutes one', () => {
    // The other divergence, and the larger one: `col('Background Color') or
    // slots['black']` — and Ansi 7 for the foreground — is the prototype's silent
    // substitution, and a whole theme then hangs off a colour the file never carried.
    const text = readFileSync(GRUVBOX_ITERM, 'utf8')
    const noBackground = text.replace(/<key>Background Color<\/key>\s*<dict>[\s\S]*?<\/dict>/, '')
    expect(noBackground).not.toContain('Background Color')
    expect(parseItermcolors(noBackground, 'gruvbox')).toEqual({
      ok: false,
      reason: 'itermcolors file is missing Background Color'
    })
  })

  it('names a file with no name at all instead of leaving the type empty', () => {
    // Pinned because this string surfaces verbatim in slice 4's per-row reason: a
    // nameless file used to print `Unsupported theme file type:  — expected …`.
    expect(loadThemeText('', '')).toEqual({
      ok: false,
      reason: 'Unsupported theme file type: unnamed file — expected .yaml, .yml or .itermcolors'
    })
  })

  it('names the file, not the path, when the name has no extension', () => {
    // The slot names a *type*, and a path is not one: this used to print
    // `Unsupported theme file type: /Users/me/themes/MyPalette — …`, which reads as the
    // app having no idea what it is looking at.
    expect(loadThemeText('/Users/me/themes/MyPalette', '')).toEqual({
      ok: false,
      reason: 'Unsupported theme file type: MyPalette — expected .yaml, .yml or .itermcolors'
    })
  })

  it('does not offer a dotfile’s leading dot as its type', () => {
    // `.itermcolors` with no stem: `extensionOf` deliberately answers `''` for it — a
    // leading dot is not an extension — so printing the name in the type slot declared
    // unsupported the very extension the same sentence lists as supported
    // (`… type: .itermcolors — expected .yaml, .yml or .itermcolors`).
    expect(loadThemeText('/Users/me/themes/.itermcolors', '')).toEqual({
      ok: false,
      reason:
        'Unsupported theme file type: a dotfile with no usable extension (.itermcolors) — expected .yaml, .yml or .itermcolors'
    })
  })

  it('never throws, whatever it is handed', () => {
    const empty: string[] = ['', 'not a plist', '<?xml version="1.0"?>', '<plist></plist>']
    for (const text of empty) {
      expect(() => parseItermcolors(text, 'x')).not.toThrow()
      expect(() => loadThemeText('x.itermcolors', text)).not.toThrow()
    }
    expect(() => loadThemeText('x.yaml', '')).not.toThrow()
    expect(() => loadThemeText('x.YAML', '')).not.toThrow()
    expect(() => loadThemeText('', '')).not.toThrow()
  })
})
