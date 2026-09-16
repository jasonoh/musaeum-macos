import type { AccentSlot, ThemeIr, ThemeVariant } from '@shared/theme.types'

/**
 * base16/base24 scheme -> IR, transliterated from `derive.py` lines 103–145.
 *
 * base00..0F already carry the semantics we need, so this is a straight read and
 * the lossy step is "none of consequence". The YAML is read with the prototype's
 * own line regexes rather than a YAML parser: base16 files are machine-generated
 * and shape-stable, and the alternative is a parsing dependency in the trusted
 * path for a file the user picked.
 */

/** `base00`..`base0F`, in the prototype's order — note the uppercase hex letters,
 *  which is also how the curated corpus spells them. */
export const BASE16_KEYS: string[] = Array.from({ length: 16 }, (_, i) =>
  `base${i.toString(16).toUpperCase().padStart(2, '0')}`
)

export type Base16Scheme = {
  meta: Record<string, string>
  palette: Record<string, string>
}

export type Base16ParseResult =
  | { ok: true; scheme: Base16Scheme }
  | { ok: false; reason: string }

/** The four `key: "value"` lines the prototype reads, plus the palette slots. */
const META_KEYS = ['name', 'author', 'variant', 'system'] as const

/** Which IR slot each palette key fills. Every one of the eight is always read. */
const ACCENT_KEYS: Record<AccentSlot, string> = {
  red: 'base08',
  orange: 'base09',
  yellow: 'base0A',
  green: 'base0B',
  cyan: 'base0C',
  blue: 'base0D',
  purple: 'base0E',
  brown: 'base0F'
}

/**
 * The prototype's own `re.search` over a line: the caller passes the pattern's
 * one capture group (as `derive.py` writes them), and this returns it.
 */
function searchLine(text: string, key: string, body: string): string | null {
  const m = text.match(new RegExp(`^${key}\\s*:\\s*"?${body}"?`, 'm'))
  return m ? m[1].trim() : null
}

export function parseBase16(text: string): Base16ParseResult {
  const meta: Record<string, string> = {}
  for (const key of META_KEYS) {
    const value = searchLine(text, key, '([^"#\\n]*)')
    if (value !== null) meta[key] = value
  }

  const found = new Map<string, string>()
  const missing: string[] = []
  for (const key of BASE16_KEYS) {
    // `^\\s*base0A\\s*:\\s*"?#?([0-9a-fA-F]{6})"?` — the prototype's own regex, which
    // tolerates the quoted and the bare forms the corpus mixes
    const value = searchLine(text, `\\s*${key}`, '#?([0-9a-fA-F]{6})')
    if (value === null) missing.push(key)
    else found.set(key, '#' + value.toLowerCase())
  }
  // A scheme missing a slot is reported, never patched: the derivation would
  // otherwise invent a colour the file never carried (D9).
  if (missing.length > 0) {
    return { ok: false, reason: `base16 scheme missing ${missing.join(', ')}` }
  }
  // Complete: the loop above rejected every slot it could not read.
  const palette = Object.fromEntries(found) as Record<string, string>
  return { ok: true, scheme: { meta, palette } }
}

/** base00..0F already carry the semantics we need — a straight read. */
export function base16ToIr(scheme: Base16Scheme): ThemeIr {
  const { meta, palette } = scheme
  const accents = {} as Record<AccentSlot, string>
  for (const [slot, key] of Object.entries(ACCENT_KEYS)) {
    accents[slot as AccentSlot] = palette[key]
  }
  // The prototype passes `variant` through and tests it as `=== 'dark'`, so anything
  // the file does not spell exactly `dark` behaves as a light scheme here too.
  const declared = meta.variant ?? 'dark'
  const variant: ThemeVariant = declared === 'dark' ? 'dark' : 'light'
  return {
    name: meta.name ?? 'untitled',
    author: meta.author ?? '',
    variant,
    source: 'base16',
    bg: palette.base00,
    bg2: palette.base01,
    bg3: palette.base02,
    border: palette.base03,
    muted: palette.base04,
    fg: palette.base05,
    fg_bright: palette.base07,
    accents,
    accent_hint: palette.base09,
    notes: []
  }
}
