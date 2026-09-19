import { basename, dirname } from 'path'
import type { AccentSlot, ThemeIr, ThemeVariant } from '@shared/theme.types'
import { hexToRgb, lstar } from '../color'

/**
 * Obsidian `theme.css` -> the same IR a base16 scheme produces — the *pure* half
 * of slice 6's resolver.
 *
 * **The rule, and the measurement behind it.** Obsidian ships no palette format;
 * it ships a role ontology whose values are frequently *computed*
 * (`hsl(var(--base-h), …)`, `var()` chains, `color-mix()`), so they only exist
 * inside a live cascade. The Electron half (`resolve-css.ts`) runs the
 * stylesheet and reads the roles back; this file decides what those strings
 * mean. Three measured facts shape it:
 *
 * 1. **What comes back is the substituted token stream, not a colour.** Chromium
 *    answers `getComputedStyle(body).getPropertyValue('--x')` with `#171c28`,
 *    `rgb(22, 22, 30)`, `hsl(220, 12%, calc(18% - 2%))`,
 *    `color-mix( in hsl, #1d2433, #2f3b54 )`, `color(srgb 0.149 0.186 0.264)`,
 *    `rgba(40, 45, 55, 0.65)` or `''` — so the resolver's probe element resolves
 *    the CSS value before it reaches `normalizeColour`, which accepts exactly
 *    the four shapes Chromium then hands back and answers `null` for anything
 *    else. A value that still *looks* computed is `null`: that is the honest
 *    answer for one the resolver did not manage to resolve, and a payload that
 *    can only be a hex colour cannot carry CSS, a URL, or a selector (AC6.3).
 * 2. **The canonical role list alone admits 2 of the 6 themes installed on this
 *    machine.** These themes are written against Obsidian's *own* base
 *    stylesheet, so `--color-base-00…100` and `--color-red` are declared by
 *    Obsidian, not by the theme — and our resolver document is a bare `data:`
 *    URL, so `--background-primary: var(--color-base-00)` resolves to empty.
 *    Hence a three-rung ladder: Obsidian's canonical name, then the prototype's
 *    own fallback column (`derive.py`'s `OBSIDIAN_ROLE_MAP`), then Obsidian's
 *    `--color-base-*` ramp. With it, 6 of 6 resolve.
 * 3. **Alpha is dropped, not composited.** Surfaces are opaque (the prototype's
 *    rule, and the reason a 60 %-alpha `#8695b799` reads as a surface at all).
 *    Compositing would be a guess about intent — halcyon's translucent `faint`
 *    is a text tone over several backdrops — and it would invent a colour the
 *    theme never declared. So the alpha is dropped and every role it was
 *    dropped for is named in `notes`, which puts the loss in the picker's
 *    disclosure rather than in silence.
 *
 * Nothing here reads a file, touches `electron`, or awaits: the adapter is
 * decided entirely by its inputs, which is why `obsidian.test.ts` can pin the
 * whole rule set with inline read sets and no user theme file in the repo.
 */

/** The nine roles the ladder resolves, in ladder order. */
export type ObsidianRole =
  'canvas' | 'panel' | 'raised' | 'border' | 'text' | 'muted' | 'faint' | 'accent' | 'on_acc'

/**
 * What the resolver read back: variable name -> the trimmed string the page
 * handed over, exactly as it was (a substituted token stream, not a colour).
 *
 * A missing variable is *absent* rather than `''`, but both read as unresolved:
 * `normalizeColour('')` is `null`, so the two spellings of "this theme does not
 * declare it" take the same path.
 */
export type ObsidianReads = Record<string, string>

/** The file an Obsidian theme is: `<folder>/theme.css`. */
export const OBSIDIAN_THEME_FILE = 'theme.css'

/**
 * The folder that names an Obsidian theme, or `null` when the path has none.
 *
 * One rule, two callers that must agree: the importer builds the id
 * (`obsidian:<folder>`) from it and the resolver builds the IR's display name
 * from it. A path with no folder — a bare `theme.css`, or `/theme.css` — names
 * no theme, and both callers treat that as a rejection rather than inventing a
 * name (`basename('/')` is `''`).
 */
export function themeFolderName(path: string): string | null {
  const folder = basename(dirname(path))
  return folder === '' || folder === '.' || folder === '..' ? null : folder
}

const ROLE_ORDER: readonly ObsidianRole[] = [
  'canvas',
  'panel',
  'raised',
  'border',
  'text',
  'muted',
  'faint',
  'accent',
  'on_acc'
]

const ACCENT_ORDER: readonly AccentSlot[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'brown'
]

/**
 * The three rungs, per role, in the order they are tried.
 *
 * Rung 2 is the prototype's own `OBSIDIAN_ROLE_MAP` fallback column, preserved
 * because §2.6 says to (`derive.py:258-267`). Rung 3 is the new one: Obsidian's
 * own ramp, which is the vocabulary modern themes actually declare. Only the
 * surface and text roles get rung 3 — accents have no `--color-base-*` name to
 * stand in for them, and a grey "red" would be worse than the declared fallback.
 *
 * `muted` and `faint` cross-reference each other's canonical name last: a theme
 * that declares only one of the two dim text tones has still named a tone for
 * the other, and that is closer to its intent than a surface colour.
 */
export const OBSIDIAN_ROLE_LADDER: Record<ObsidianRole, readonly string[]> = {
  canvas: ['--background-secondary', '--halcyon-base-blue-01', '--color-base-00'],
  panel: ['--background-primary', '--halcyon-base-blue-02', '--color-base-10'],
  raised: ['--background-primary-alt', '--halcyon-base-blue-03', '--color-base-20'],
  border: [
    '--background-modifier-border',
    '--halcyon-base-blue-03',
    '--color-base-30',
    '--color-base-25'
  ],
  text: ['--text-normal', '--halcyon-base-grey-light', '--color-base-100', '--color-base-90'],
  muted: [
    '--text-muted',
    '--halcyon-base-grey-dark',
    '--color-base-70',
    '--color-base-60',
    '--text-faint'
  ],
  faint: [
    '--text-faint',
    '--halcyon-base-grey-token',
    '--color-base-60',
    '--color-base-50',
    '--text-muted'
  ],
  accent: ['--interactive-accent', '--halcyon-accent', '--color-accent', '--text-accent'],
  on_acc: ['--text-on-accent', '--halcyon-base-blue-03', '--color-base-20', '--color-base-10']
}

/**
 * The eight accent slots' ladders: Obsidian's own `--color-*` name, then the
 * halcyon palette variable the prototype kept for the same slot.
 *
 * No `--color-base-*` rung: those are greys, and an accent that is grey is a
 * colour the theme did not declare.
 */
export const OBSIDIAN_ACCENT_LADDER: Record<AccentSlot, readonly string[]> = {
  red: ['--color-red', '--halcyon-palette-salmon'],
  orange: ['--color-orange', '--halcyon-palette-orange'],
  yellow: ['--color-yellow', '--halcyon-palette-yellow'],
  green: ['--color-green', '--halcyon-palette-lime'],
  cyan: ['--color-cyan', '--halcyon-palette-cyan'],
  blue: ['--color-blue', '--halcyon-palette-blue'],
  purple: ['--color-purple', '--halcyon-palette-lilac'],
  brown: ['--color-pink', '--halcyon-palette-pink']
}

/** A role's value, once the page's string has been read as a colour. */
interface Resolved {
  hex: string
  droppedAlpha: boolean
}

/** One entry of a resolved `.css`: the palette and the variant it implies. */
export interface ResolvedObsidianVariant {
  variant: ThemeVariant
  ir: ThemeIr
}

/**
 * What a `.css` resolves to: one entry, or two (D5), or the reason it could not.
 *
 * `ok: true` is spelled out rather than implied by `variants`' presence, so a
 * caller narrows on one field the same way it does for `LoadedTheme`.
 */
export type ResolvedObsidianFile =
  { ok: true; variants: ResolvedObsidianVariant[] } | { ok: false; reason: string }

/** `rgb()`'s component list: commas and/or whitespace, `/` before an alpha. */
function splitComponents(body: string): string[] {
  return body.split(/[\s,/]+/).filter((part) => part !== '')
}

/** One `rgb()` channel, 0..255. A percentage is a percentage *of 255*. */
function rgbChannel(raw: string): number | null {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(raw)
  if (percent !== null) return (Number(percent[1]) / 100) * 255
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null
  return Number(raw)
}

/** One `color(srgb …)` channel: a 0..1 float, scaled to 0..255. */
function srgbChannel(raw: string): number | null {
  if (!/^\d*\.?\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value * 255 : null
}

/** An alpha component, 0..1. A percentage is of 1. */
function alphaOf(raw: string): number | null {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(raw)
  if (percent !== null) return Number(percent[1]) / 100
  if (!/^\d*\.?\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** The quantisation `rgbToHex` uses, without its `Rgb`-triple detour. */
function byteOf(channel: number): number {
  return Math.max(0, Math.min(255, Math.round(channel)))
}

function hexOf(channels: number[]): string {
  return '#' + channels.map((c) => byteOf(c).toString(16).padStart(2, '0')).join('')
}

/**
 * One read value -> `#rrggbb`, or `null` for anything that is not a colour this
 * engine can store.
 *
 * Accepted, and only these: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`,
 * `rgb(r g b)`, `rgba(r,g,b,a)`, `color(srgb r g b)`, `color(srgb r g b / a)`.
 * `hsl()`, `color-mix()` and `calc()` are **not** evaluated here: the resolver's
 * probe element resolves them before the value arrives, so one that still looks
 * computed is one the page could not resolve, and `null` is the honest answer
 * (`none`, `url(…)`, `var(--missing)`, `''` all land in the same arm).
 *
 * `color(srgb …)` carries 0..1 floats and is scaled by 255; `rgb()` carries
 * 0..255 integers or percentages of 255.
 *
 * **Alpha is dropped, and reported.** `droppedAlpha` is true only when the
 * value actually carried a translucent alpha — an opaque `#rrggbbff` loses
 * nothing and so is not reported, which keeps `notes` free of non-losses.
 */
export function normalizeColour(raw: string): { hex: string; droppedAlpha: boolean } | null {
  const text = raw.trim()
  if (text === '') return null

  const hex = /^#([0-9a-fA-F]+)$/.exec(text)
  if (hex !== null) {
    const body = hex[1]
    const expanded =
      body.length === 3
        ? body
            .split('')
            .map((c) => c + c)
            .join('')
        : body
    if (expanded.length !== 6 && expanded.length !== 8) return null
    const alpha = expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1
    return { hex: `#${expanded.slice(0, 6).toLowerCase()}`, droppedAlpha: alpha < 1 }
  }

  const fn = /^(rgb|rgba)\((.*)\)$/i.exec(text)
  if (fn !== null) {
    const parts = splitComponents(fn[2])
    if (parts.length !== 3 && parts.length !== 4) return null
    const channels = parts.slice(0, 3).map(rgbChannel)
    if (channels.some((channel) => channel === null)) return null
    const alpha = parts.length === 4 ? alphaOf(parts[3]) : 1
    if (alpha === null) return null
    return { hex: hexOf(channels as number[]), droppedAlpha: alpha < 1 }
  }

  const srgb = /^color\(\s*srgb\s+(.*)\)$/i.exec(text)
  if (srgb !== null) {
    const parts = splitComponents(srgb[1])
    if (parts.length !== 3 && parts.length !== 4) return null
    const channels = parts.slice(0, 3).map(srgbChannel)
    if (channels.some((channel) => channel === null)) return null
    const alpha = parts.length === 4 ? alphaOf(parts[3]) : 1
    if (alpha === null) return null
    return { hex: hexOf(channels as number[]), droppedAlpha: alpha < 1 }
  }

  return null
}

/**
 * The prototype's variant rule: `lstar(canvas) < 0.5` is dark, else light.
 *
 * A read is labelled by its **canvas's own lightness and never by the class it
 * was read under** (D5). The class is a probe: Dracula + LYT's `theme-light`
 * class resolves to a dark palette, and a theme that does not gate on
 * `body:is(.theme-dark)` answers the same palette under both classes.
 */
export function variantFromCanvas(canvasHex: string): ThemeVariant {
  return lstar(hexToRgb(canvasHex)) < 0.5 ? 'dark' : 'light'
}

/**
 * The variable to blame in a rejection: the first rung of the ladder the theme
 * actually *declared*, or the canonical name when it declared none of them.
 *
 * It is deliberately not "the first rung that read empty". A theme that writes
 * `--text-normal: none` (or a `var()` chain the probe could not resolve, or
 * `hsl(212, 15%, calc(13% + 65%))`) has *declared* the canonical name — the fact
 * the user can act on is that the thing they declared is not a colour, and
 * naming the halcyon rung two steps down would send them looking for a variable
 * their theme was never supposed to have.
 */
function blameVar(reads: ObsidianReads, role: ObsidianRole): string {
  const ladder = OBSIDIAN_ROLE_LADDER[role]
  return ladder.find((name) => (reads[name] ?? '').trim() !== '') ?? ladder[0]
}

/** A role's value: the first rung whose read normalizes to a colour, or `null`. */
function resolveRole(reads: ObsidianReads, role: ObsidianRole): Resolved | null {
  for (const name of OBSIDIAN_ROLE_LADDER[role]) {
    const found = normalizeColour(reads[name] ?? '')
    if (found !== null) return found
  }
  return null
}

/** An accent slot's value, the same way — with no `--color-base-*` rung. */
function resolveAccent(reads: ObsidianReads, slot: AccentSlot): Resolved | null {
  for (const name of OBSIDIAN_ACCENT_LADDER[slot]) {
    const found = normalizeColour(reads[name] ?? '')
    if (found !== null) return found
  }
  return null
}

/**
 * The roles whose absence rejects the theme: exactly the three `derive.ts`
 * requires beyond the accents (`bg`, `fg`, `border`). Everything else is
 * advisory — `muted`/`bg2`/`bg3` are optional by the derivation's own reading,
 * and `on_acc_hint` is optional by contract (`ThemeIr:46`).
 */
const REQUIRED_ROLES: readonly ObsidianRole[] = ['canvas', 'border', 'text']

/**
 * The four accents the derivation requires (`derive.ts:203-211`). They are named
 * here because the *contract* distinguishes them — but, unlike a role, an accent
 * that cannot resolve does not reject the theme: it falls back to the theme's
 * own muted tone (see the assembly below). Measured, that difference is what
 * keeps Blue Topaz and Obsidianite — which declare no accent variable at all —
 * importable instead of rejected on their four required slots.
 */
const REQUIRED_ACCENTS: readonly AccentSlot[] = ['red', 'orange', 'yellow', 'green']

/** The roles that have a field to omit. `faint` has none (see the body). */
const OPTIONAL_ROLES: readonly ObsidianRole[] = ['panel', 'raised', 'muted', 'on_acc']

/**
 * The read set -> the IR, or the reason it cannot be one.
 *
 * Required roles resolve through their full ladder or the theme is rejected,
 * **naming every unresolved role and the variable to blame for it** — the rung
 * the theme actually declared, or the canonical name when it declared none (see
 * `blameVar`). One missing surface is a fact the user can act on, and a rejection
 * that named only the first would send them round the loop again (AC6.4's shape,
 * extended from one role to the list).
 *
 * `faint` is resolved but stored nowhere: `ThemeIr` has no slot for it (the
 * prototype resolves it and discards it too), and it is here because the accent
 * fallback reaches for it. So an unresolved `faint` omits nothing and needs no
 * note.
 *
 * `variant` comes from the canvas's own lightness, never from `variantClass` —
 * see `variantFromCanvas`. The class is only the probe the read was taken under,
 * and a read where the two disagree says so in `notes`.
 */
export function obsidianIr(
  reads: ObsidianReads,
  opts: { name: string; sourcePath: string; variantClass: 'dark' | 'light' }
): { ok: true; ir: ThemeIr } | { ok: false; reason: string } {
  const resolved: Partial<Record<ObsidianRole, Resolved>> = {}
  for (const role of ROLE_ORDER) {
    const found = resolveRole(reads, role)
    if (found !== null) resolved[role] = found
  }
  const accentValues: Partial<Record<AccentSlot, Resolved>> = {}
  for (const slot of ACCENT_ORDER) {
    const found = resolveAccent(reads, slot)
    if (found !== null) accentValues[slot] = found
  }

  const unresolved = REQUIRED_ROLES.filter((role) => resolved[role] === undefined)
  if (unresolved.length > 0) {
    const names = unresolved.map((role) => blameVar(reads, role)).join(', ')
    const verb = unresolved.length === 1 ? 'is' : 'are'
    return {
      ok: false,
      reason: `obsidian:${opts.name}: ${unresolved.join(', ')} ${verb} unresolved (no usable ${names})`
    }
  }

  // The required three are present — the check above returned every other case.
  const bg = (resolved.canvas as Resolved).hex
  const border = (resolved.border as Resolved).hex
  const fg = (resolved.text as Resolved).hex
  const variant = variantFromCanvas(bg)
  const notes: string[] = []

  const faded = ROLE_ORDER.filter((role) => resolved[role]?.droppedAlpha === true)
  const fadedAccents = ACCENT_ORDER.filter((slot) => accentValues[slot]?.droppedAlpha === true)
  if (faded.length > 0 || fadedAccents.length > 0) {
    notes.push(`alpha dropped for ${[...faded, ...fadedAccents].join(', ')} — surfaces are opaque`)
  }

  for (const role of OPTIONAL_ROLES) {
    if (resolved[role] === undefined) {
      notes.push(
        `${role} unresolved — omitted (no usable ${OBSIDIAN_ROLE_LADDER[role].join(', ')})`
      )
    }
  }

  // The accent fallback, which is the prototype's own rule and the difference
  // between 2 of 6 and 6 of 6 of this machine's installed themes: an accent the
  // theme does not declare takes the theme's resolved muted tone (then `faint`,
  // then `fg`), because otherwise the four *required* accents reject every theme
  // that leans on Obsidian's defaults — measured 0 of 8 on Blue Topaz and
  // Obsidianite, both of which declare no `--color-*` at all. The derivation
  // already has a rule for "no chromatic accent supplied": it keeps the app's
  // own identity rather than inventing a hue. Which slots fell back is named in
  // `notes`, so the disclosure is not silent. `fg` is the last resort because
  // `text` is a required role: there is always a tone to fall back to.
  const fallbackRole: ObsidianRole =
    resolved.muted !== undefined ? 'muted' : resolved.faint !== undefined ? 'faint' : 'text'
  const fallback = resolved[fallbackRole] as Resolved
  const fallbackName = fallbackRole === 'text' ? 'fg' : fallbackRole
  const accents = {} as Record<AccentSlot, string>
  const fellBack: AccentSlot[] = []
  for (const slot of ACCENT_ORDER) {
    const found = accentValues[slot]
    if (found !== undefined) accents[slot] = found.hex
    else {
      accents[slot] = fallback.hex
      fellBack.push(slot)
    }
  }
  if (fellBack.length > 0) {
    const required = fellBack.filter((slot) => REQUIRED_ACCENTS.includes(slot))
    notes.push(
      `${fellBack.join(', ')} accents fell back to the ${fallbackName} tone` +
        (required.length > 0 ? ` (${required.join(', ')} are required by the derivation)` : '')
    )
  }

  if ((opts.variantClass === 'dark') !== (variant === 'dark')) {
    notes.push(`resolved under .theme-${opts.variantClass}, whose canvas is ${variant}`)
  }

  // `accent_hint` is the one role the derivation treats as a *hint*: a value that
  // holds 3:1 on a panel wins, and otherwise `derive.ts` reaches for the warmer of
  // orange/yellow itself (`derive.ts:314-321`). So an unresolved accent role hands
  // over the orange slot — the slot the derivation would have reached for — which
  // is itself the fallback tone when this theme declares no accent at all. Nothing
  // here invents a hue the theme did not supply.
  const accentHint = resolved.accent ?? accentValues.orange ?? { hex: accents.orange }

  // `bg2`/`bg3`/`muted` are spelled *required* on `ThemeIr` while the derivation
  // reads none of `bg2`/`bg3` and treats a missing `muted` as "use `fg`"
  // (`derive.ts:216`) — so an unresolved optional role is omitted here, as D4
  // says, rather than substituted with a colour the theme never declared. The
  // cast is that disagreement, kept in one place: a caller that spread these
  // defaults instead would ship a palette the theme did not name.
  const ir = {
    name: opts.name,
    author: 'Obsidian theme',
    variant,
    source: 'obsidian',
    bg,
    ...(resolved.panel !== undefined ? { bg2: resolved.panel.hex } : {}),
    ...(resolved.raised !== undefined ? { bg3: resolved.raised.hex } : {}),
    border,
    ...(resolved.muted !== undefined ? { muted: resolved.muted.hex } : {}),
    fg,
    // No provider role for "brighter than normal": Obsidian names one text tone,
    // so the bright end is that tone (the prototype spells it the same way).
    fg_bright: fg,
    accents,
    accent_hint: accentHint.hex,
    ...(resolved.on_acc !== undefined ? { on_acc_hint: resolved.on_acc.hex } : {}),
    notes
  } as ThemeIr

  return { ok: true, ir }
}
