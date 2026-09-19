import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ThemeTokens } from '@shared/theme.types'
import { applyTokens, hexToChannels, OWNED_CSS_VARS, SHADOW_VARS, tokensToCssVars } from './css'

/**
 * The apply path, decided without a DOM.
 *
 * There is no `document` in this environment (`F12`: `environment: 'node'`, no
 * jsdom), which is the whole reason `applyTokens` takes the element it writes
 * to: the values are asserted as data, and the one case that needs a target
 * passes a stub.
 */

const ROOT_CSS = join(process.cwd(), 'src', 'index.css')

/** `:root`'s custom properties, keyed by name — the same parse slice 1 pins. */
function rootVars(): Record<string, string> {
  const css = readFileSync(ROOT_CSS, 'utf8')
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)
  if (!block) throw new Error('src/index.css has no :root block')
  const vars: Record<string, string> = {}
  for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) vars[m[1]] = m[2].trim()
  return vars
}

/**
 * `:root`'s declared scheme — the one thing in that block that is not a custom
 * property, so it is read out of the block rather than out of the var map.
 */
function rootColorScheme(): string {
  const css = readFileSync(ROOT_CSS, 'utf8')
  const block = css.match(/:root\s*\{([\s\S]*?)\}/)
  const scheme = block?.[1].match(/color-scheme\s*:\s*([a-z]+)\s*;/)
  if (!scheme) throw new Error(':root declares no color-scheme')
  return scheme[1]
}

/** '13 11 9' → '#0d0b09', the inverse of `hexToChannels`. */
function hexFromChannels(channels: string): string {
  return (
    '#' +
    channels
      .split(/\s+/)
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** `:root`, as a token set — so nothing here re-states the palette as a literal. */
function tokensFromRoot(vars: Record<string, string>): ThemeTokens {
  const inkAt = (step: string): string => hexFromChannels(vars[`--ink-${step}`])
  return {
    ink: {
      '950': inkAt('950'),
      '900': inkAt('900'),
      '850': inkAt('850'),
      '800': inkAt('800'),
      '700': inkAt('700'),
      '600': inkAt('600'),
      '500': inkAt('500')
    },
    parchment: {
      parchment: hexFromChannels(vars['--parchment']),
      parchment_dim: hexFromChannels(vars['--parchment-dim']),
      parchment_faint: hexFromChannels(vars['--parchment-faint'])
    },
    gold: {
      '300': hexFromChannels(vars['--gold-300']),
      '400': hexFromChannels(vars['--gold-400']),
      '500': hexFromChannels(vars['--gold-500']),
      '600': hexFromChannels(vars['--gold-600'])
    },
    on_acc: hexFromChannels(vars['--on-accent']),
    scrim: hexFromChannels(vars['--scrim']),
    shadow: 0.55,
    dark: true
  }
}

/**
 * The twelve slice-7a names and the four slice-5 names this path owns — both at
 * module scope because the `tokensToCssVars`, `applyTokens` and `OWNED_CSS_VARS`
 * groups all read the same lists, and every count in this file is one of them
 * plus the sixteen colours.
 */
const STATUS_VARS = ['danger', 'ok', 'warn'].flatMap((family) =>
  ['400', '500', '600', 'on'].map((step) => `--status-${family}-${step}`)
)
/**
 * Slice 5's: the three derived shadow alphas and the declared scheme. They are
 * also the only four values this path writes that are *not* colours — three bare
 * numbers and a keyword — which is why the "channel triplet" case has to name
 * its exclusions instead of sweeping the whole map.
 */
/**
 * Slice 5's four owned names. The three alphas come from the module's own
 * `SHADOW_VARS` rather than a second spelling of them here, so this file cannot
 * drift from the apply path about which properties exist.
 */
const DERIVED_VARS = [...SHADOW_VARS, 'color-scheme']

/** A token set carrying every status family — what every built-in derives. */
function withStatus(): ThemeTokens {
  const ramp = { '400': '#e5484d', '500': '#dc3545', '600': '#b02a37', on: '#ffffff' }
  return { ...tokensFromRoot(rootVars()), status: { danger: ramp, ok: ramp, warn: ramp } }
}

/**
 * A light theme as the engine derives one: the weak shadow strength and
 * `dark: false`. Nothing else about it is light — the alphas and the scheme are
 * the whole subject here, and the four page colours are the reader's.
 */
function lightTokens(): ThemeTokens {
  return { ...tokensFromRoot(rootVars()), shadow: 0.16, dark: false }
}

describe('hexToChannels', () => {
  it('writes a hex as the channel triplet Tailwind composes', () => {
    expect(hexToChannels('#0d0b09')).toBe('13 11 9')
    expect(hexToChannels('#ffffff')).toBe('255 255 255')
    expect(hexToChannels('#000000')).toBe('0 0 0')
    expect(hexToChannels('#fdf6e3')).toBe('253 246 227')
  })

  it('accepts either case, and emits no #', () => {
    expect(hexToChannels('#0D0B09')).toBe('13 11 9')
    expect(hexToChannels('#E8C987')).toBe('232 201 135')
  })

  it.each(['13 11 9', '#0d0b0', '#0d0b09f', '0d0b09', '#gggggg', '', '#12345'])(
    'refuses %j rather than writing it through',
    (notAColour) => {
      expect(() => hexToChannels(notAColour)).toThrow(/Not a #rrggbb colour/)
    }
  )
})

describe('tokensToCssVars', () => {
  const vars = rootVars()

  it('parses :root at all', () => {
    // Every equality below reads this map; an empty parse would make the loop
    // compare nothing to nothing. 19 properties until slice 7a authored the twelve
    // `--status-*` values, 31 after.
    expect(Object.keys(vars)).toHaveLength(31)
  })

  it("writes exactly today's :root values for the default palette", () => {
    const written = tokensToCssVars(tokensFromRoot(vars))
    const owned = Object.keys(written).sort()
    expect(owned).toHaveLength(20)
    // Every property it writes has to exist in :root with the same value: this is
    // the "the app renders today's pixels" half of AC3.4, decided against the
    // stylesheet rather than against a second copy of the palette. `color-scheme`
    // is the one declaration in the block that is not a custom property, so it is
    // added from the block itself.
    const expected = {
      ...Object.fromEntries(Object.entries(vars).filter(([name]) => owned.includes(name))),
      'color-scheme': rootColorScheme()
    }
    expect(written).toEqual(expected)
    // The bridge A24 named: the token set carries one strength (0.55), `:root`
    // carries three alphas, and this is the arithmetic that makes them the same
    // pixels on the default theme (AC5.4).
    expect(vars['--shadow-a1']).toBe('0.5')
    expect(vars['--shadow-a2']).toBe('0.35')
    expect(vars['--shadow-a3']).toBe('0.6')
  })

  it('emits channel triplets for every colour it writes, and never a hex', () => {
    // `tailwind.config.js` composes `rgb(var(--x) / <alpha-value>)`; a hex in the
    // variable is invalid at computed-value time, so every opacity-modified
    // utility is dropped silently with the build still green.
    const written = tokensToCssVars(tokensFromRoot(vars))
    const colours = Object.entries(written).filter(([name]) => !DERIVED_VARS.includes(name))
    expect(colours).toHaveLength(16)
    for (const [name, value] of colours) {
      expect(value, name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
      expect(value, name).not.toContain('#')
    }
    expect(written['--ink-950']).toBe('13 11 9')
    expect(written['--ink-950']).not.toBe('#0d0b09')
    // The four that are not colours are not forced into the colour shape.
    expect(written['--shadow-a1']).toBe('0.5')
    expect(written['color-scheme']).toBe('dark')
  })

  it('derives the shadow alphas and the colour scheme, and leaves status to slice 7a (AC5.4)', () => {
    // Inverted by slice 5: these four were `:root`'s and this path deliberately
    // did not own them. They are derived now — which is what makes a light theme
    // a light app rather than a light app with dark shadows and dark native
    // chrome — and owned, so a switch reconciles them like every other property.
    const written = tokensToCssVars(tokensFromRoot(vars))
    for (const name of DERIVED_VARS) expect(Object.keys(written), name).toContain(name)
    for (const name of Object.keys(written)) expect(name).not.toMatch(/^--status-/)
    // The default theme's own strength reproduces the authored alphas exactly.
    expect(written['--shadow-a1']).toBe('0.5')
    expect(written['--shadow-a2']).toBe('0.35')
    expect(written['--shadow-a3']).toBe('0.6')
    expect(written['color-scheme']).toBe('dark')
  })

  it('scales the alphas with the theme’s own shadow strength, and flips the scheme (AC5.4)', () => {
    const light = tokensToCssVars(lightTokens())
    // 0.16 × base / 0.55, rounded to three decimals: the settled numbers, not
    // 0.14545454545454545 — an unrounded alpha is correct and incomparable.
    expect(light['--shadow-a1']).toBe('0.145')
    expect(light['--shadow-a2']).toBe('0.102')
    expect(light['--shadow-a3']).toBe('0.175')
    expect(light['color-scheme']).toBe('light')
    // Both ends of the clamp: a strength of zero is no shadow at all, and one
    // stronger than `:root`'s own cannot go past full.
    expect(tokensToCssVars({ ...lightTokens(), shadow: 0 })['--shadow-a3']).toBe('0')
    const strong = tokensToCssVars({ ...lightTokens(), shadow: 1 })
    expect(strong['--shadow-a2']).toBe('0.636')
    expect(strong['--shadow-a3']).toBe('1')
  })

  it('writes the status family when the set carries one, and only then', () => {
    const ramp = { '400': '#e5484d', '500': '#dc3545', '600': '#b02a37', on: '#ffffff' }
    const withStatus: ThemeTokens = {
      ...tokensFromRoot(vars),
      status: { danger: ramp, ok: ramp, warn: ramp }
    }
    const written = tokensToCssVars(withStatus)
    expect(Object.keys(written)).toHaveLength(32)
    expect(written['--status-danger-400']).toBe('229 72 77')
    expect(written['--status-ok-on']).toBe('255 255 255')
    expect(written['--status-warn-500']).toBe('220 53 69')
    expect(Object.keys(tokensToCssVars(tokensFromRoot(vars)))).toHaveLength(20)
  })
})

describe('applyTokens', () => {
  /** The element `applyTokens` writes to, recording what it was asked to set. */
  function recorder(): {
    el: {
      style: { setProperty(k: string, v: string): void; removeProperty(k: string): void }
    }
    set: Record<string, string>
    removed: Set<string>
  } {
    const set: Record<string, string> = {}
    const removed = new Set<string>()
    return {
      set,
      removed,
      el: {
        style: {
          setProperty: (name, value) => {
            set[name] = value
          },
          removeProperty: (name) => {
            delete set[name]
            removed.add(name)
          }
        }
      }
    }
  }

  it('needs an injected element, because there is no document here', () => {
    expect(typeof document).toBe('undefined')
  })

  it('writes every variable tokensToCssVars decided, and nothing else', () => {
    const tokens = tokensFromRoot(rootVars())
    const { el, set } = recorder()
    applyTokens(tokens, el)
    expect(set).toEqual(tokensToCssVars(tokens))
    expect(Object.keys(set)).toHaveLength(20)
  })

  it('replaces a value rather than appending to it', () => {
    // A theme switch is the same keys with new values; an implementation that
    // accumulated would leave the previous theme's channels on the element.
    const { el, set } = recorder()
    applyTokens(tokensFromRoot(rootVars()), el)
    const light = tokensFromRoot({
      ...rootVars(),
      '--ink-950': '253 246 227',
      '--ink-900': '238 232 213'
    })
    applyTokens(light, el)
    expect(set['--ink-950']).toBe('253 246 227')
    expect(Object.keys(set)).toHaveLength(20)
  })

  it('reports a malformed colour as a reason, and writes nothing at all', () => {
    // Finding 5's decider. Pre-fix this was `expect(applyTokens(...)).toThrow()`
    // — the throw the renderer's `useTheme` effect let reach React, which
    // unmounts the tree. The value form is what makes both call sites safe.
    //
    // The failing set is a *different* palette, not the standing one with one bad
    // field: if it differed only in `on_acc`, an implementation that wrote
    // property-by-property before failing would produce a map identical to the one
    // already standing, and "writes nothing" would pass on it. Measured — the
    // first version of this case used the standing palette and the interleaved
    // mutation (M6) left it green.
    const light = tokensFromRoot({
      ...rootVars(),
      '--ink-950': '253 246 227',
      '--ink-900': '238 232 213'
    })
    const broken: ThemeTokens = { ...light, on_acc: 'not a colour' }
    const { el, set } = recorder()
    applyTokens(tokensFromRoot(rootVars()), el)
    const before = { ...set }

    let reason: string | null | undefined
    expect(() => {
      reason = applyTokens(broken, el)
    }).not.toThrow()
    expect(reason).toMatch(/Not a #rrggbb colour/)
    // A refused apply writes nothing — no half-a-palette.
    expect(set).toEqual(before)
    expect(set['--ink-950']).toBe('13 11 9')
  })

  it('returns null for a set it can write, and writes every variable of it', () => {
    const tokens = tokensFromRoot(rootVars())
    const { el, set } = recorder()
    expect(applyTokens(tokens, el)).toBeNull()
    expect(set).toEqual(tokensToCssVars(tokens))
    expect(Object.keys(set)).toHaveLength(20)
  })

  it('reports a target that refuses a write, rather than throwing out of React', () => {
    const brokenTarget = {
      style: {
        setProperty: () => {
          throw new Error('the element is detached')
        },
        removeProperty: () => undefined
      }
    }
    let reason: string | null | undefined
    expect(() => {
      reason = applyTokens(tokensFromRoot(rootVars()), brokenTarget)
    }).not.toThrow()
    expect(reason).toContain('the element is detached')
  })

  it('both renderer call sites call it, which is what makes each of them safe', () => {
    // The behavioural half — "a throw in `useTheme`'s effect unmounts the tree" —
    // needs React and a DOM, and F12's config is `environment: 'node'`. So the
    // call sites are decided the way AC3.1(b) decides `createWindow()`: by their
    // source. Both apply through the one guarded export, so neither can be the
    // unguarded one; the ordering walks that decide *where* each applies live in
    // `src/stores/theme.store.test.ts`.
    for (const file of ['src/main.tsx', 'src/hooks/useTheme.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).toMatch(/applyTokens\(/)
    }
  })

  // --- AC3/§2.7: the switch *away* from a status family ------------------------

  it('removes a status family the incoming set does not carry', () => {
    // Every built-in's derived tokens carry a status family; the built-in default
    // does not (`:root` has no status block until 7a). `setProperty` alone can
    // only add, so switching back to the default left twelve stale
    // `--status-*` properties on `documentElement` — silently, with a green
    // suite, and live the moment slice 4's picker can switch themes.
    const { el, set, removed } = recorder()
    applyTokens(withStatus(), el)
    applyTokens(tokensFromRoot(rootVars()), el)

    for (const name of STATUS_VARS) expect(removed.has(name), name).toBe(true)
    expect(Object.keys(set)).toHaveLength(20)
    for (const name of STATUS_VARS) expect(set[name], name).toBeUndefined()
  })

  it('leaves the status family alone when the incoming set carries one', () => {
    // The complement: the removal above must be decided by the incoming set, not
    // by "always clear the twelve". A status-carrying set decides all twelve, so
    // the second apply writes them and takes nothing away.
    const { el, set } = recorder()
    applyTokens(tokensFromRoot(rootVars()), el)
    applyTokens(withStatus(), el)
    expect(Object.keys(set)).toHaveLength(32)
    for (const name of STATUS_VARS) expect(set[name], name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
    expect(set['--status-danger-400']).toBe('229 72 77')
    // And nothing outside the owned set was dropped by either apply.
    expect(Object.keys(set).filter((name) => !OWNED_CSS_VARS.includes(name))).toEqual([])
  })

  it('writes the four derived properties on every apply, and never takes them away (AC5.4)', () => {
    // Inverted by slice 5. These were `:root`'s and the reconcile reached
    // nowhere near them; they are decided by *every* token set now, so a switch
    // replaces them rather than clearing them — and the removal half must still
    // not touch them, because `:root`'s authored block has to remain the default
    // for the frame before JS runs.
    const { el, set, removed } = recorder()
    applyTokens(withStatus(), el)
    applyTokens(tokensFromRoot(rootVars()), el)
    for (const name of DERIVED_VARS) {
      expect(set[name], name).toBeDefined()
      expect(removed.has(name), name).toBe(false)
    }
    expect(set['color-scheme']).toBe(rootColorScheme())
    expect(set['--shadow-a1']).toBe('0.5')
  })

  it('carries a light theme’s weaker alphas and its scheme through to the element', () => {
    // The one-line live claim of AC5.4, decided as far as a DOM-less environment
    // can take it: what lands on `documentElement` is what the tokens decided.
    const { el, set } = recorder()
    applyTokens(lightTokens(), el)
    expect(set).toMatchObject({
      '--shadow-a1': '0.145',
      '--shadow-a2': '0.102',
      '--shadow-a3': '0.175',
      'color-scheme': 'light'
    })
  })
})

describe('OWNED_CSS_VARS — the names the apply path may write *and* take away', () => {
  it('is exactly the 32 names, the four derived ones included (AC5.4)', () => {
    // Ownership is what the removal half runs on, so it is worth pinning: an
    // owned name the set never writes is removed on every apply, and a name this
    // path does not own is never touched. Slice 5 moves
    // `--shadow-a1/a2/a3` and `color-scheme` from the second group to the first.
    const palette = [
      '--ink-950',
      '--ink-900',
      '--ink-850',
      '--ink-800',
      '--ink-700',
      '--ink-600',
      '--ink-500',
      '--parchment',
      '--parchment-dim',
      '--parchment-faint',
      '--gold-300',
      '--gold-400',
      '--gold-500',
      '--gold-600',
      '--on-accent',
      '--scrim'
    ]
    expect([...OWNED_CSS_VARS].sort()).toEqual([...palette, ...DERIVED_VARS, ...STATUS_VARS].sort())
    expect(new Set(OWNED_CSS_VARS).size).toBe(32)
    for (const name of DERIVED_VARS) expect(OWNED_CSS_VARS, name).toContain(name)
  })
})
