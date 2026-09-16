import type { AccentSlot, LoadedTheme, Rgb, ThemeIr } from '@shared/theme.types'
import { chroma, hueDelta, lstar, mix, rgbToHex } from '../color'

/**
 * Apple XML plist (`.itermcolors`) -> the same IR a base16 scheme produces,
 * transliterated from `derive.py` lines 148–245.
 *
 * `derive.py` used `plistlib`; there is no plist dependency here (adding one is
 * an escalation, not an implementer's call), so a narrow scanner reads the flat
 * shape iTerm actually writes: a `key` element naming a colour, followed by a
 * `dict` carrying `Red|Green|Blue Component` as `real` or `integer`.
 *
 * Where `plistlib` could never hand the prototype a missing slot, this scanner
 * can — so a slot that will not parse is a rejection naming it rather than a
 * silently synthetic colour (D9). The two do **not** agree on every file a
 * `plistlib` reader would accept, in two measured ways, both of them fail-closed
 * by D9: a component written as `<string>` (plistlib plus `float()` reads it and
 * the prototype derives from it; this scanner rejects the slot) and a file with
 * no `Background Color` (the prototype substitutes Ansi 0, and Ansi 7 for the
 * foreground; this scanner rejects). On a file that spells both window colours as
 * `real`/`integer` and carries all sixteen slots, the two agree.
 */

/**
 * ANSI slot -> the plist key it lives under, in the prototype's declaration
 * order. The order is part of the rule: the grey ramp is a stable sort over it.
 */
const ITERM_SLOTS = [
  ['black', 'Ansi 0 Color'],
  ['red', 'Ansi 1 Color'],
  ['green', 'Ansi 2 Color'],
  ['yellow', 'Ansi 3 Color'],
  ['blue', 'Ansi 4 Color'],
  ['purple', 'Ansi 5 Color'],
  ['cyan', 'Ansi 6 Color'],
  ['white', 'Ansi 7 Color'],
  ['br_black', 'Ansi 8 Color'],
  ['br_red', 'Ansi 9 Color'],
  ['br_green', 'Ansi 10 Color'],
  ['br_yellow', 'Ansi 11 Color'],
  ['br_blue', 'Ansi 12 Color'],
  ['br_purple', 'Ansi 13 Color'],
  ['br_cyan', 'Ansi 14 Color'],
  ['br_white', 'Ansi 15 Color']
] as const

type SlotName = (typeof ITERM_SLOTS)[number][0]

/**
 * Which ANSI slot fills each accent. Terminal files carry no base01/02/03, so
 * the ramp below bg/fg has to be *inferred*: this is the lossy step that makes
 * the IR necessary. (Slot map follows the conventions the iTerm palette
 * collections document: 0->bg, 1->red, 2->green, 3->yellow, 4->blue, 5->purple,
 * 6->cyan, 8->comment/border, 13->bright fg, 15->lightest.)
 */
const ITERM_ACCENTS: [AccentSlot, SlotName][] = [
  ['red', 'red'],
  ['orange', 'br_yellow'],
  ['yellow', 'yellow'],
  ['green', 'green'],
  ['cyan', 'cyan'],
  ['blue', 'blue'],
  ['purple', 'purple'],
  ['brown', 'br_red']
]

// ------------------------------------------------------------------ plist scan

type PlistValue = string | number | PlistDict | null
interface PlistDict {
  [key: string]: PlistValue
}

/**
 * Every element a `.itermcolors` uses, in one pass: a key, a scalar (real /
 * integer / string), a container opening, and a container closing. Everything
 * else in the document — declarations, comments — is skipped.
 */
const PLIST_TAG =
  /<key>([\s\S]*?)<\/key>|<(real|integer|string)>([\s\S]*?)<\/\2>|<(dict|array)\s*\/>|<(dict|array)>|<\/(?:dict|array)>/g

/**
 * The document's top-level dict, or `null` if it is not a balanced plist — which
 * is what a truncated file looks like from here.
 */
function scanPlist(text: string): PlistDict | null {
  const frames: PlistDict[] = []
  let root: PlistDict | null = null
  let pendingKey: string | null = null

  // A scalar with no key in front of it is not part of the shape, so it is dropped
  // rather than guessed at.
  const put = (value: PlistValue): void => {
    const top = frames[frames.length - 1]
    if (top === undefined || pendingKey === null) return
    top[pendingKey] = value
    pendingKey = null
  }

  for (const m of text.matchAll(PLIST_TAG)) {
    if (m[1] !== undefined) {
      pendingKey = m[1].trim()
      continue
    }
    if (m[3] !== undefined) {
      if (m[2] === 'string') {
        put(m[3])
      } else {
        const raw = m[3].trim()
        // A component that will not read as a number stays null and is rejected by
        // the caller, never coerced to 0.
        const n = raw === '' ? Number.NaN : Number(raw)
        put(Number.isFinite(n) ? n : null)
      }
      continue
    }
    if (m[4] !== undefined) {
      put({})
      continue
    }
    if (m[5] !== undefined) {
      // Only a `<dict>` may open the *root* frame. `plistlib` would hand the
      // prototype a list for an array-rooted document and the prototype would
      // crash on it, so reading one as a dict here would be a false positive the
      // scanner can see for free.
      if (frames.length === 0 && m[5] !== 'dict') return null
      const frame: PlistDict = {}
      put(frame)
      frames.push(frame)
      continue
    }
    const closed = frames.pop()
    if (closed === undefined) return null
    if (frames.length === 0) root = closed
  }
  if (frames.length !== 0) return null
  return root
}

/** One component of a colour entry, or `null` if the entry does not carry one. */
function component(entry: PlistValue | undefined, name: string): number | null {
  if (typeof entry !== 'object' || entry === null) return null
  const value = entry[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function colorOf(entry: PlistValue | undefined): Rgb | null {
  const r = component(entry, 'Red Component')
  const g = component(entry, 'Green Component')
  const b = component(entry, 'Blue Component')
  if (r === null || g === null || b === null) return null
  return [r, g, b]
}

// -------------------------------------------------------------------- adapter

/**
 * @param text the file's bytes, decoded
 * @param name the palette's display name — the prototype names the IR after the
 *   file's stem, and text alone carries no name, so the loader passes it
 */
export function parseItermcolors(text: string, name = ''): LoadedTheme {
  const doc = scanPlist(text)
  if (doc === null) {
    return { ok: false, reason: 'not a well-formed plist (truncated, unbalanced or not XML)' }
  }

  const colors = new Map<SlotName, Rgb>()
  const missing: string[] = []
  for (const [slot, key] of ITERM_SLOTS) {
    const parsed = colorOf(doc[key])
    if (parsed === null) missing.push(key)
    else colors.set(slot, parsed)
  }
  const background = colorOf(doc['Background Color'])
  if (background === null) missing.push('Background Color')
  const foreground = colorOf(doc['Foreground Color'])
  if (foreground === null) missing.push('Foreground Color')
  // The explicit null tests are here because a missing window colour only *seems*
  // impossible: each one is also pushed to `missing`, so they can never fire alone.
  if (missing.length > 0 || background === null || foreground === null) {
    return { ok: false, reason: `itermcolors file is missing ${missing.join(', ')}` }
  }

  // All sixteen ANSI slots plus both window colours are present: the check above
  // rejected every one it could not read.
  const slots = Object.fromEntries(colors) as Record<SlotName, Rgb>
  const bg = background
  const fg = foreground
  const dark = lstar(bg) < lstar(fg)

  // Ramp inference. Terminal files carry no base01/02/03, so the surface stops
  // above the canvas have to be *reconstructed*: we sort whatever greys the
  // palette actually ships, then place control points by interpolation between bg
  // and fg. This is the lossy step the IR absorbs.
  const textDir = (cands: Rgb[]): Rgb => {
    let best = cands[0]
    for (const c of cands.slice(1)) {
      // `max(…, key=lstar)` keeps the FIRST maximal element, so a tie stays put.
      const better = dark ? lstar(c) > lstar(best) : lstar(c) < lstar(best)
      if (better) best = c
    }
    return best
  }
  const brightest = textDir([slots.br_white, slots.white])

  // Only greys in the background's own hue family may stand in for surfaces: a
  // luminance sort alone picks up desaturated greens/teals out of the ANSI slots,
  // which is how a warm scheme grows a green sidebar.
  const isGrey = (slot: SlotName): boolean =>
    chroma(slots[slot]) < 0.035 && (chroma(bg) < 0.01 || hueDelta(slots[slot], bg) < 0.61)
  const greys = ITERM_SLOTS.map(([slot]) => [slot, lstar(slots[slot])] as const)
    .filter(([slot]) => isGrey(slot))
    .sort((a, b) => a[1] - b[1])
  const lo = Math.min(lstar(bg), lstar(fg))
  const hi = Math.max(lstar(bg), lstar(fg))
  const interior = greys.filter(([, lt]) => lo < lt && lt < hi).map(([slot]) => slots[slot])

  // Pick a mid-tone for elevation: prefer a real grey from the palette, otherwise
  // synthesise one in the background's own hue.
  let bg2: Rgb
  let bg3: Rgb
  let border: Rgb
  if (interior.length >= 2) {
    bg2 = interior[0]
    bg3 = interior[Math.floor(interior.length / 2)]
    border = interior[interior.length - 1]
  } else {
    bg2 = mix(bg, fg, 0.1)
    bg3 = mix(bg, fg, 0.18)
    border = mix(bg, fg, 0.28)
  }

  const accents = {} as Record<AccentSlot, string>
  for (const [slot, source] of ITERM_ACCENTS) accents[slot] = rgbToHex(slots[source])

  const ir: ThemeIr = {
    name,
    author: '',
    variant: dark ? 'dark' : 'light',
    source: 'itermcolors',
    bg: rgbToHex(bg),
    bg2: rgbToHex(bg2),
    bg3: rgbToHex(bg3),
    border: rgbToHex(border),
    muted: rgbToHex(mix(bg, fg, 0.62)),
    fg: rgbToHex(fg),
    fg_bright: rgbToHex(brightest),
    accents,
    // terminal palettes: the bright slot is the vivid one
    accent_hint: rgbToHex(slots.br_yellow),
    notes: [`ramp inferred from ${greys.length} greys; no base01-03 in source`]
  }
  return { ok: true, ir }
}
