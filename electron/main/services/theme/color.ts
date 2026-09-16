import type { Rgb } from '@shared/theme.types'

/**
 * Colour maths, transliterated from `derive.py` lines 24–98 and 348–357.
 *
 * Colours are `[number, number, number]` triples in 0..1 wherever the prototype
 * returns a tuple, and hex strings wherever it returns hex — matching each
 * function's own choice is what keeps the two comparable line by line.
 *
 * The arithmetic here is deliberately uneven: `mix` interpolates in Oklab by
 * default but in plain sRGB when asked for `'linear'`, because the surface
 * ladder's asymmetry is what preserves a palette's own hue drift. Where a rule
 * looks odd, the oddity is the prototype's and is load-bearing.
 */

/** `hex_to_rgb`: `#rrggbb` -> a 0..1 triple. No short form; the prototype has none. */
export function hexToRgb(h: string): Rgb {
  const body = h.replace(/^#/, '')
  return [
    parseInt(body.slice(0, 2), 16) / 255,
    parseInt(body.slice(2, 4), 16) / 255,
    parseInt(body.slice(4, 6), 16) / 255
  ]
}

/**
 * `round()` with Python's tie rule: halves go to the even neighbour, where
 * `Math.round` sends them up. It differs only at exact halves, but the port's
 * whole claim is byte-for-byte agreement with the prototype, and this is the
 * cheapest way to be exact.
 */
function roundHalfEven(v: number): number {
  const floor = Math.floor(v)
  const frac = v - floor
  if (frac > 0.5) return floor + 1
  if (frac < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** `rgb_to_hex`: quantise to 8-bit and clamp, the prototype's order. */
export function rgbToHex(c: Rgb): string {
  const channels = c.map((v) => Math.max(0, Math.min(255, roundHalfEven(v * 255))))
  return '#' + channels.map((v) => v.toString(16).padStart(2, '0')).join('')
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c))
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

export function relLuminance(c: Rgb): number {
  return 0.2126 * srgbToLinear(c[0]) + 0.7152 * srgbToLinear(c[1]) + 0.0722 * srgbToLinear(c[2])
}

/** WCAG contrast, both arguments triples — the prototype's own signature. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Oklab: interpolating surfaces in Oklab keeps perceived steps even, which is
 * what makes a 7-stop surface ladder look authored rather than mechanical.
 */
export function srgbToOklab(c: Rgb): Rgb {
  const r = srgbToLinear(c[0])
  const g = srgbToLinear(c[1])
  const b = srgbToLinear(c[2])
  const l0 = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m0 = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s0 = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  // `copysign(abs(v) ** (1/3), v)`: the cube root is taken on the magnitude so a
  // negative component keeps its sign instead of producing NaN
  const l = Math.sign(l0) * Math.pow(Math.abs(l0), 1 / 3)
  const m = Math.sign(m0) * Math.pow(Math.abs(m0), 1 / 3)
  const s = Math.sign(s0) * Math.pow(Math.abs(s0), 1 / 3)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function oklabToSrgb(lab: Rgb): Rgb {
  const [L, a, b] = lab
  const l0 = L + 0.3963377774 * a + 0.2158037573 * b
  const m0 = L - 0.1055613458 * a - 0.0638541728 * b
  const s0 = L - 0.0894841775 * a - 1.291485548 * b
  // `v ** 3`, kept as a power rather than `v * v * v` so the rounding matches
  // the prototype's own operation
  const l = Math.pow(l0, 3)
  const m = Math.pow(m0, 3)
  const s = Math.pow(s0, 3)
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

/** `'oklab'` is the prototype's default; anything else is a componentwise mix. */
export type MixSpace = 'oklab' | 'linear'

/** `mix(a, b, t)`: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: Rgb, b: Rgb, t: number, space: MixSpace = 'oklab'): Rgb {
  if (space === 'oklab') {
    const la = srgbToOklab(a)
    const lb = srgbToOklab(b)
    return oklabToSrgb([
      la[0] + (lb[0] - la[0]) * t,
      la[1] + (lb[1] - la[1]) * t,
      la[2] + (lb[2] - la[2]) * t
    ])
  }
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function chroma(c: Rgb): number {
  const lab = srgbToOklab(c)
  return Math.hypot(lab[1], lab[2])
}

export function lstar(c: Rgb): number {
  return srgbToOklab(c)[0]
}

export function hueAngle(c: Rgb): number {
  const lab = srgbToOklab(c)
  return Math.atan2(lab[2], lab[1])
}

export function hueDelta(x: Rgb, y: Rgb): number {
  const d = Math.abs(hueAngle(x) - hueAngle(y)) % (2 * Math.PI)
  return Math.min(d, 2 * Math.PI - d)
}

/**
 * Move lightness in Oklab while KEEPING the hue/chroma direction.
 *
 * Mixing toward the palette's foreground to raise contrast desaturates the
 * colour into it (measured: solarized's danger red became a grey-teal and still
 * missed 4.5:1). An error state has to stay red, so adjust L, not hue.
 */
export function adjustLight(c: Rgb, frac: number, up: boolean): Rgb {
  const lab = srgbToOklab(c)
  const L = up ? lab[0] + (1 - lab[0]) * frac : lab[0] * (1 - frac)
  return oklabToSrgb([Math.max(0, Math.min(1, L)), lab[1], lab[2]])
}

/** `#rgb` / `#rrggbb` / `#rrggbbaa` -> `#rrggbb`; anything else is the fallback. */
export function normalizeHex(
  v: string | null | undefined,
  fallback: string | null = null
): string | null {
  const raw = (v ?? '').trim()
  if (!/^#[0-9a-fA-F]{3,8}$/.test(raw)) return fallback
  let body = raw.slice(1)
  if (body.length === 3) body = body.split('').map((c) => c + c).join('')
  // alpha is dropped: surfaces are opaque
  if (body.length === 8) body = body.slice(0, 6)
  if (body.length !== 6) return fallback
  return '#' + body.toLowerCase()
}
