import type {
  DeriveFailure,
  DeriveResult,
  DerivedTokens,
  FloorMetric,
  FloorReason,
  GoldStep,
  InkStep,
  MalformedReason,
  Rgb,
  StatusFamily,
  StatusRamp,
  ThemeAudit,
  ThemeIr
} from '@shared/theme.types'
import {
  adjustLight,
  chroma,
  contrast,
  hexToRgb,
  lstar,
  mix,
  normalizeHex,
  relLuminance,
  rgbToHex
} from './color'

/**
 * `derive.py`'s `derive_tokens()`, transliterated (its lines 343–564).
 *
 * One rule does the heavy lifting: **every ramp slides along the palette's own
 * bg→fg axis, and only chroma comes from elsewhere.** A scheme tells us its
 * canvas, its ink, and its accent — it does not tell us how many surface steps
 * we need or where the dim-text stop should land, so we invent those rather than
 * trusting base01/base02 to be the tones the spec names them.
 *
 * The one thing this port adds is terminal verification (D3): the prototype's
 * floor loops are bounded and exit at the cap **without re-checking**, so a
 * theme that never met its floor is returned as a success whose own audit row
 * reads FAIL. Here every one of the six loops is followed by a re-check, and an
 * unmet floor becomes a `FloorFailure` value rather than a silently-broken
 * theme (`CLAUDE.md` #12: reported, never thrown). Those six are the *precise
 * early* checks; the success return is also guarded by a sweep over the whole
 * assembled audit table (A20), because the status fill audits two placements
 * while walking one score and `accent on canvas` is audited without a walk at
 * all — so a success whose own table reads FAIL is reachable without one.
 *
 * Every rule the prototype reads as an oddity is kept as-is and commented where
 * it is, because the first instinct of the next reader is to even it out.
 */

/** Contrast floors for the three text stops, keyed as the prototype keys them. */
export const TEXT_FLOORS: Record<TextStop, number> = {
  parchment: 4.5,
  parchment_dim: 3.5,
  parchment_faint: 2.2
}

type TextStop = 'parchment' | 'parchment_dim' | 'parchment_faint'

/** The surface ladder's control points, in the prototype's order (950 → 500). */
const INK_STOPS: InkStep[] = ['950', '900', '850', '800', '700', '600', '500']
const INK_CONTROL = [0.0, 0.1, 0.19, 0.3, 0.42, 0.58, 0.8]

const TEXT_STOPS: [TextStop, number][] = [
  ['parchment', 0.0],
  ['parchment_dim', 0.42],
  ['parchment_faint', 0.62]
]

/** Which accent slot each status family reads, in audit order. */
const STATUS_SLOTS: [StatusFamily, 'red' | 'green' | 'yellow'][] = [
  ['danger', 'red'],
  ['ok', 'green'],
  ['warn', 'yellow']
]

/**
 * `max(seq, key=…)`: Python returns the FIRST maximal element, so a tie keeps
 * the earlier candidate rather than the better-looking one.
 */
function maxBy<T>(items: T[], value: (item: T) => number): T {
  let best = items[0]
  let bestValue = value(best)
  for (const item of items.slice(1)) {
    const v = value(item)
    if (v > bestValue) {
      best = item
      bestValue = v
    }
  }
  return best
}

/**
 * The prototype's `best_on`: it maximises over `(ratio, hex)` *tuples*, so a
 * ratio tie is broken by the hex string rather than by position — Python's
 * tuple comparison, which is not what `maxBy` above does.
 */
function bestOn(fill: string, ends: string[]): [number, string] {
  let best: [number, string] = [contrast(hexToRgb(ends[0]), hexToRgb(fill)), ends[0]]
  for (const end of ends.slice(1)) {
    const candidate: [number, string] = [contrast(hexToRgb(end), hexToRgb(fill)), end]
    if (candidate[0] > best[0] || (candidate[0] === best[0] && candidate[1] > best[1])) {
      best = candidate
    }
  }
  return best
}

/**
 * A floor that could not be met, as the rejection value. `metric` says which
 * scale `ratio` and `floor` are on — every contrast floor is a WCAG ratio, the
 * scrim's is an absolute relative luminance — because a caller that formats the
 * two the same way prints `0.06 (min 0.06)` beside `1.0 (min 4.5)` and means
 * nothing by it.
 */
function failure(
  role: string,
  ratio: number,
  floor: number,
  metric: FloorMetric = 'contrast'
): FloorReason {
  return { kind: 'floor', role, ratio, floor, metric }
}

/** The derivation could not measure at all, as the rejection value. */
function malformed(role: string, detail: string): MalformedReason {
  return { kind: 'malformed', role, detail }
}

/** How much of a rejected value a `malformed` detail may quote. */
const MAX_SHOWN_VALUE = 48

/**
 * A *bounded* rendering of the caller's value for a `malformed` detail — the one
 * helper that exists so this entry point never calls into a value it did not
 * build. `typeof` is safe on anything; `String(v)` is not, because it calls the
 * caller's own `toString`/`Symbol.toPrimitive`, which may throw (`{ toString() {
 * throw } }`, and also the `Object.create(null)` case, which has no primitive
 * conversion at all). A throw there would be a throw out of the frozen entry
 * point, which is the defect this whole file exists to close.
 *
 * Bounded for the same reason it is careful: this string is printed verbatim in
 * slice 4's per-row reason, so a 200-character field must not become a
 * 200-character message — the shown value is capped and the cap is visible.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing'
  let shown: string
  try {
    shown = String(value)
  } catch {
    // The value's own conversion threw: say what it is rather than what it meant.
    return `<${typeof value}>`
  }
  return shown.length > MAX_SHOWN_VALUE ? `${shown.slice(0, MAX_SHOWN_VALUE)}…` : shown
}

/**
 * `normalizeHex` is the only hex validator here (a second one is forbidden), and
 * it is typed for strings. This wrapper adds the type check the two *hint* fields
 * need: they are advisory, so a provider that spells a hint wrong falls back
 * rather than failing the theme.
 */
function hintHex(value: unknown): string | null {
  return typeof value === 'string' ? normalizeHex(value) : null
}

export function deriveTheme(ir: ThemeIr): DeriveResult {
  const audits: ThemeAudit[] = []
  const adjusted: string[] = []
  // This entry point is total. Slices 3 and 6 hand it an IR this package did not
  // build, so every field the derivation dereferences is validated here, before
  // `hexToRgb` ever sees it, and the validated spelling is what is used from here
  // on — `normalizeHex` expands `#abc`, which is also what stops a three-digit
  // input from becoming NaN channels downstream (it reads digits, not intent).
  if (ir === null || typeof ir !== 'object') {
    return {
      ok: false,
      reason: malformed('ir', 'no theme IR was supplied'),
      adjusted,
      notes: []
    }
  }
  // The prototype mutates the IR it is handed (`ir.setdefault('notes', []).append(…)`)
  // and this port used to alias the caller's array. It copies instead: aliasing makes
  // `result.notes === ir.notes`, so deriving the same IR twice appends every note a
  // second time (measured on a re-derive of dracula.yaml) — which is exactly what
  // slice 3's re-derive-on-version-mismatch path does. The *rules* are unchanged;
  // only this side effect is deliberately departed from.
  //
  // Elements are filtered to strings rather than coerced: `String(note)` would call
  // the caller's own `toString`, the one call this entry point must not make on a
  // value it did not build (see `describeValue`), and a `string[]` that may hold
  // anything is not a type. A non-string note is dropped, and dropping it is the
  // honest reading: it was never a note.
  const rawNotes: unknown[] = Array.isArray(ir.notes) ? ir.notes : []
  const notes: string[] = rawNotes.filter((note): note is string => typeof note === 'string')
  const reject = (reason: DeriveFailure): DeriveResult => ({ ok: false, reason, adjusted, notes })

  const accents = (ir.accents ?? {}) as Record<string, unknown>
  const required: [string, unknown][] = [
    ['bg', ir.bg],
    ['fg', ir.fg],
    ['border', ir.border],
    ['accents.red', accents.red],
    ['accents.orange', accents.orange],
    ['accents.yellow', accents.yellow],
    ['accents.green', accents.green]
  ]
  // `muted` may be *absent* — the status block falls back to `fg` — but a value the
  // provider did supply still has to read as a colour, `null` included. It used to be
  // swallowed here while every other required field rejected it, so a caller that
  // spelled "no muted" as `null` got the `fg` status ramp and no rejection at all.
  if (ir.muted !== undefined) required.push(['muted', ir.muted])
  const norm: Record<string, string> = {}
  for (const [role, value] of required) {
    const normalized = typeof value === 'string' ? normalizeHex(value) : null
    if (normalized === null) {
      return reject(malformed(role, `expected a hex colour, got ${describeValue(value)}`))
    }
    norm[role] = normalized
  }

  // `variant` was the one required field nothing inspected, and it is not a colour:
  // it decides the *direction* of every ramp in this file (which way the surface
  // ladder rises, which way a text stop dims, which way a status step walks, the
  // shadow's alpha). Measured before this check: `variant: 42`, `'Dark'`, `'bogus'`
  // or a missing field returned `ok: true` on 7 of the 15 vendored palettes — every
  // one of them a wrong-polarity theme shipped as a success. It is rejected as
  // `malformed` rather than defaulted, because guessing the polarity is how a
  // caller gets the wrong theme silently. The adapters' own defaults are upstream of
  // this and unchanged: a file with no `variant:` line still loads as dark.
  if (ir.variant !== 'dark' && ir.variant !== 'light') {
    return reject(
      malformed('variant', `expected 'dark' or 'light', got ${describeValue(ir.variant)}`)
    )
  }

  const bg = hexToRgb(norm.bg)
  const fg = hexToRgb(norm.fg)
  const dark = ir.variant === 'dark'

  // -- surface ladder: 7 stops from canvas (950) upward, resampled in Oklab
  // from the source's own bg->border span so hue drift is preserved.
  const border = hexToRgb(norm.border)
  let span = border
  const offAxis = dark ? lstar(span) < lstar(bg) : lstar(span) > lstar(bg)
  if (offAxis || chroma(span) > Math.max(0.06, chroma(bg) * 3)) {
    span = mix(mix(bg, fg, 0.3), border, 0.35)
    notes.push('border tone off-axis; span synthesised from bg->fg')
  }
  const ink = {} as Record<InkStep, string>
  INK_STOPS.forEach((name, i) => {
    const t = INK_CONTROL[i]
    // `'linear'` here is the prototype's name for a componentwise sRGB mix, NOT an
    // interpolation in linear light. The asymmetry with every other ramp in this
    // file is deliberate: it is what keeps the source palette's own drift.
    ink[name] = rgbToHex(t === 0 ? bg : mix(bg, span, t, 'linear'))
  })

  // -- text ramp: fg dimmed toward the canvas, floors enforced per role
  const parchment = {} as Record<TextStop, string>
  for (const [key, t] of TEXT_STOPS) {
    let c = t === 0 ? fg : mix(fg, bg, t)
    const floor = TEXT_FLOORS[key]
    const backdrop = key === 'parchment' ? bg : hexToRgb(ink['900'])
    if (contrast(c, backdrop) < floor) {
      for (let i = 0; i < 24; i += 1) {
        c = mix(c, fg, 0.06)
        if (contrast(c, backdrop) >= floor) break
      }
      adjusted.push(`${key} raised to meet ${floor}:1`)
    }
    // The walk above caps out at 24 steps without re-checking. Verify the floor on
    // the value that actually ships — the quantised hex, which is the same quantity
    // the audits below measure — and reject rather than return a broken theme.
    const stop = rgbToHex(c)
    const measured = contrast(hexToRgb(stop), backdrop)
    // A non-finite measurement is the other half of totality: every floor test in
    // this file is `<`, and `NaN < floor` is false, so a NaN that reached one would
    // pass it and ship a theme whose tokens read `#NaNNaN0a`.
    if (!Number.isFinite(measured)) {
      return reject(
        malformed('fg', `the ${key} stop measured ${measured} against its backdrop`)
      )
    }
    if (measured < floor) {
      return reject(failure(key, measured, floor))
    }
    parchment[key] = stop
  }
  audits.push({
    name: 'text on canvas',
    ratio: contrast(hexToRgb(parchment.parchment), bg),
    floor: 4.5
  })
  audits.push({
    name: 'dim text on panel',
    ratio: contrast(hexToRgb(parchment.parchment_dim), hexToRgb(ink['900'])),
    floor: 3.5
  })
  audits.push({
    name: 'faint text on panel',
    ratio: contrast(hexToRgb(parchment.parchment_faint), hexToRgb(ink['900'])),
    floor: 2.2
  })

  // -- accent: a role the provider names itself beats a heuristic, so try the
  // declared hint first and fall back to the warm slot. (base09/base0A is the
  // warm slot in the overwhelming majority of schemes, which is what lets the
  // app keep its amber identity without hard-coding amber.)
  const hint = hintHex(ir.accent_hint)
  const hinted =
    hint !== null && contrast(hexToRgb(hint), hexToRgb(ink['900'])) >= 3.0 ? hint : null
  // `max(…, key=chroma)` over the pair keeps the first on a tie, i.e. orange.
  const acc = hexToRgb(
    hinted ??
      maxBy([norm['accents.orange'], norm['accents.yellow']], (h) => chroma(hexToRgb(h)))
  )
  // The ramp's *emphasis* direction is always toward fg -- the readable end of the
  // axis in both variants -- so 300 stays legible on a light theme too.
  const gold: Record<GoldStep, string> = {
    400: rgbToHex(acc),
    300: rgbToHex(mix(acc, fg, 0.3)),
    500: rgbToHex(mix(acc, bg, 0.14)),
    600: rgbToHex(mix(acc, bg, 0.34))
  }
  // accent must be legible as *text* at 400 (links, active nav, labels)
  for (let i = 0; i < 20; i += 1) {
    if (contrast(hexToRgb(gold['400']), hexToRgb(ink['900'])) >= 3.0) break
    gold['400'] = rgbToHex(mix(hexToRgb(gold['400']), fg, 0.06))
  }
  if (gold['400'] !== rgbToHex(acc)) adjusted.push('accent nudged toward fg for 3:1 on panels')
  const accentOnPanel = contrast(hexToRgb(gold['400']), hexToRgb(ink['900']))
  if (!Number.isFinite(accentOnPanel)) {
    return reject(malformed('accents', `the accent ramp measured ${accentOnPanel} on a panel`))
  }
  if (accentOnPanel < 3.0) {
    return reject(failure('gold-400', accentOnPanel, 3.0))
  }
  audits.push({ name: 'accent on panel', ratio: accentOnPanel, floor: 3.0 })
  // The accent's *second* placement has no walk of its own — `gold-400` is nudged
  // toward `fg` until it clears the panel, and nothing makes it clear the canvas —
  // so this row is the sweep's business and only the sweep verifies it (measured
  // before the sweep: a dark palette whose `gold-400` separates from `ink-900` by
  // 3.0:1 but from `ink-950` by 2.88:1 returned `ok: true` with this row reading
  // FAIL).
  audits.push({
    name: 'accent on canvas',
    ratio: contrast(hexToRgb(gold['400']), hexToRgb(ink['950'])),
    floor: 3.0
  })

  // -- on-accent: text that sits *on* a filled accent surface (the Import pill, a
  // selected chip). No provider supplies this role, and on a light theme the
  // obvious answer (ink-950) is near-white-on-orange and fails. So: derive the
  // text end AND walk the fill until the pair holds 4:1 -- a light scheme's bright
  // accent is simply not a surface that can carry text, and the fix is to deepen
  // the fill, not to paper over it.
  const onEnds = [ink['950'], parchment.parchment]
  let fill = gold['500']
  let onAcc: string
  let moved = false
  const declaredOn = hintHex(ir.on_acc_hint)
  const declaredHolds =
    declaredOn !== null &&
    Math.max(
      contrast(hexToRgb(declaredOn), hexToRgb(gold['500'])),
      contrast(hexToRgb(declaredOn), hexToRgb(gold['400']))
    ) >= 4.0
  if (declaredOn !== null && declaredHolds) {
    // The provider named this role itself (Obsidian's --text-on-accent) and it
    // holds the floor -- an observed role beats a derived one.
    onAcc = declaredOn
  } else {
    onAcc = onEnds[0]
    for (let i = 0; i < 24; i += 1) {
      const [ratio, end] = bestOn(fill, onEnds)
      onAcc = end
      if (ratio >= 4.0) break
      fill = rgbToHex(
        maxBy(
          [mix(hexToRgb(fill), fg, 0.08), mix(hexToRgb(fill), bg, 0.08)],
          (c) => bestOn(rgbToHex(c), onEnds)[0]
        )
      )
      moved = true
    }
  }
  if (moved) {
    gold['500'] = fill
    adjusted.push('filled accent deepened to carry 4:1 text')
  }
  const onAccRatio = contrast(hexToRgb(onAcc), hexToRgb(gold['500']))
  if (!Number.isFinite(onAccRatio)) {
    return reject(malformed('accents', `on-accent measured ${onAccRatio} on the filled accent`))
  }
  if (onAccRatio < 4.0) {
    return reject(failure('on-accent', onAccRatio, 4.0))
  }
  audits.push({ name: 'on-accent / filled', ratio: onAccRatio, floor: 4.0 })

  // -- scrim (J6/J8): a role, not a ramp step. It DARKENS what it covers in both
  // variants -- four of its twelve sites are chips laid over arbitrary cover art,
  // and a light theme must not turn those into light washes any more than it may
  // wash out a dialog. So it is derived from the deep end of the axis and pushed
  // to black, never from a flipped ramp step.
  const deep = dark ? bg : fg
  let scrim = mix(deep, [0, 0, 0], 0.35)
  if (relLuminance(scrim) >= 0.06) {
    // Too light to veil: walk it to black until it is a real shadow. The prototype
    // records the note on the successful path only, so a walk that runs out is
    // silent -- which is exactly what the verification below turns into a rejection.
    for (let i = 0; i < 24; i += 1) {
      scrim = mix(scrim, [0, 0, 0], 0.08)
      if (relLuminance(scrim) < 0.06) {
        adjusted.push('scrim deepened to stay a veil in this variant')
        break
      }
    }
  }
  const scrimHex = rgbToHex(scrim)
  const scrimLum = relLuminance(hexToRgb(scrimHex))
  if (!Number.isFinite(scrimLum)) {
    return reject(
      malformed(dark ? 'bg' : 'fg', `the scrim measured ${scrimLum} of absolute luminance`)
    )
  }
  if (scrimLum >= 0.06) {
    // `metric: 'luminance'`: this floor is an absolute luminance, not a contrast
    // ratio, so `{ role: 'scrim', ratio: 0.0608, floor: 0.06 }` must not be
    // formatted as if it were `{ role: 'parchment', ratio: 1, floor: 4.5 }`.
    return reject(failure('scrim', scrimLum, 0.06, 'luminance'))
  }
  // The audit keeps the prototype's own expression (raw triple, expressed as the
  // 0.06/lum score its floor of 1.0 is stated against).
  audits.push({
    name: 'scrim darkens (abs lum<0.06)',
    ratio: 0.06 / Math.max(relLuminance(scrim), 1e-6),
    floor: 1.0
  })

  // -- status family (J6): danger/ok/warn off the palette's own red/green/yellow.
  // 400 is the TEXT step (23 of the 53 sites are `text-red-400`, which measures
  // ~2.3:1 on a light panel today -- illegible, not merely off-palette); 500/600
  // are FILLS and carry an `on-*` foreground.
  const status = {} as Record<StatusFamily, StatusRamp>
  for (const [fam, slot] of STATUS_SLOTS) {
    const base = hexToRgb(norm[`accents.${slot}`])
    const up = dark // raise L on a dark panel, lower it on a light one

    const muted = hexToRgb(norm.muted ?? norm.fg)
    // The prototype compares the two triples directly, not their hex spellings.
    if (base[0] === muted[0] && base[1] === muted[1] && base[2] === muted[2]) {
      notes.push(
        `${fam} hue came from the extractor fallback, not a real accent -- this one needs the sandbox resolver, not the regex scrape`
      )
    }

    let textStep = base
    for (let i = 0; i < 40; i += 1) {
      if (contrast(textStep, hexToRgb(ink['900'])) >= 4.5) break
      textStep = adjustLight(textStep, 0.06, up)
    }
    if (contrast(textStep, hexToRgb(ink['900'])) < 4.5) {
      adjusted.push(`${fam}-400 could not reach 4.5:1 on a panel`)
    }
    const text400 = rgbToHex(textStep)
    const text400Ratio = contrast(hexToRgb(text400), hexToRgb(ink['900']))
    if (!Number.isFinite(text400Ratio)) {
      return reject(malformed(`accents.${slot}`, `the ${fam} text step measured ${text400Ratio}`))
    }
    if (text400Ratio < 4.5) {
      return reject(failure(`${fam}-400`, text400Ratio, 4.5))
    }

    // 600 is the DEEPER fill (Tailwind's red-600 is darker than red-500, and the
    // destructive buttons sit here): lower L in both variants.
    const deepStep = rgbToHex(adjustLight(base, 0.3, false))

    // 500 is a FILL: it must carry its own foreground AND separate from the
    // canvas. Both floors move together -- walking the value to satisfy one can
    // walk it out of the other (measured: iterm gruvbox landed at exactly 3.00:1
    // against the canvas while holding 5.47:1 for its text).
    const statEnds = [ink['950'], parchment.parchment, '#ffffff']
    const panel = hexToRgb(ink['850'])
    const score = (c: Rgb): number => {
      let on = 0
      for (const e of statEnds) on = Math.max(on, contrast(hexToRgb(e), c))
      const separation = Math.max(contrast(c, bg), contrast(c, panel))
      return Math.min(on / 4.0, separation / 3.0)
    }

    let fillRgb = base
    for (let i = 0; i < 40; i += 1) {
      if (score(fillRgb) >= 1.0) break
      const cand = [
        adjustLight(fillRgb, 0.07, false),
        adjustLight(fillRgb, 0.07, true),
        mix(fillRgb, [0, 0, 0], 0.08),
        mix(fillRgb, fg, 0.08)
      ]
      fillRgb = maxBy(cand, score)
    }
    if (score(fillRgb) < 1.0) adjusted.push(`${fam}-500 could not hold both floors`)
    // One score, two floors: >= 1.0 means 4.5-ish for the foreground *and* 3.0
    // against canvas or panel, so the rejection reports the combined score. Note what
    // "or" hides: separation from the *panel* satisfies this score while the shipped
    // `${fam}-500 vs canvas` row can still read FAIL. This check is the precise early
    // one (it names the family); the sweep at the end of this function is the general
    // guarantee that no success carries that row.
    const fillScore = score(hexToRgb(rgbToHex(fillRgb)))
    if (!Number.isFinite(fillScore)) {
      return reject(malformed(`accents.${slot}`, `the ${fam} fill scored ${fillScore}`))
    }
    if (fillScore < 1.0) {
      return reject(failure(`${fam}-500`, fillScore, 1.0))
    }
    const onFill = maxBy(statEnds, (e) => contrast(hexToRgb(e), fillRgb))
    status[fam] = { '400': text400, '500': rgbToHex(fillRgb), '600': deepStep, on: onFill }
    audits.push({
      name: `${fam}-400 on panel (text)`,
      ratio: contrast(textStep, hexToRgb(ink['900'])),
      floor: 4.5
    })
    audits.push({ name: `${fam}-500 vs canvas`, ratio: contrast(fillRgb, bg), floor: 3.0 })
    audits.push({
      name: `text on ${fam}-500`,
      ratio: contrast(hexToRgb(onFill), fillRgb),
      floor: 4.0
    })
  }

  // -- shadows are derived, not authored: the cover shadow that reads on #0d0b09
  // turns to mud on a light canvas.
  const shadow = dark ? 0.55 : 0.16
  const tokens: DerivedTokens = {
    ink,
    parchment,
    gold,
    on_acc: onAcc,
    scrim: scrimHex,
    status,
    shadow,
    dark
  }

  // -- A20: the audit table is verified against itself. The six re-checks above are
  // the *precise early* ones; this is the general guarantee, and it is the check the
  // criterion is actually stated as ("no success result may carry an audit row below
  // its own floor"). It exists because the prototype audits two placements but walks
  // one score: the status fill's guard tests `min(max-on / 4.0, max(separation from
  // the canvas, separation from the panel) / 3.0) >= 1.0`, so a fill that separates
  // from the panel but not from the canvas passes the walk while the shipped row
  // `'<family>-500 vs canvas'` (floor 3.0) reads FAIL — and `'accent on canvas'` is
  // audited with no walk of its own at all. Measured before this sweep existed: of
  // 300,000 random IRs, 40,894 returned `ok: true` and 715 of those carried a row
  // below its floor (509/480/470 across the three `X-500 vs canvas` rows, 51 on
  // `accent on canvas`). The *rules* are untouched — the score walk above still makes
  // a fill try to hold both — only what a success is allowed to carry is. The sweep
  // rejects nothing the 15 vendored palettes produce (AC2.3's corpus test).
  //
  // The finiteness arm is the other half of totality: every floor test in this file is
  // `<`, and `NaN < floor` is false, so a NaN row would pass the sweep and ship a table
  // of nulls. Measured, it is unreachable from today's rules — every row's ratio is a
  // contrast between two colours that were validated before use, and 60,000 random IRs
  // produced no non-finite row — and it stays because it is the arm that keeps the
  // invariant true if a rule above ever changes.
  for (const row of audits) {
    if (!Number.isFinite(row.ratio)) {
      return reject(malformed(row.name, `the audit row '${row.name}' measured ${row.ratio}`))
    }
    if (row.ratio < row.floor) {
      // `role` is the audit row's own name here, not a token role: the row *is* what
      // failed, and that string is what the picker prints beside it.
      return reject(failure(row.name, row.ratio, row.floor))
    }
  }
  return { ok: true, tokens, audits, adjusted, notes }
}
