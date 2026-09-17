import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ThemeTokens } from '@shared/theme.types'
import { applyTokens, hexToChannels, OWNED_CSS_VARS, tokensToCssVars } from './css'

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
 * The twelve slice-7a names this path owns, and the four slice-5 members it
 * deliberately does not — both module-scope because the `applyTokens` and
 * `OWNED_CSS_VARS` groups read the same lists.
 */
const STATUS_VARS = ['danger', 'ok', 'warn'].flatMap((family) =>
  ['400', '500', '600', 'on'].map((step) => `--status-${family}-${step}`)
)
const SLICE5 = ['--shadow-a1', '--shadow-a2', '--shadow-a3', 'color-scheme']

/** A token set carrying every status family — what every built-in derives. */
function withStatus(): ThemeTokens {
  const ramp = { '400': '#e5484d', '500': '#dc3545', '600': '#b02a37', on: '#ffffff' }
  return { ...tokensFromRoot(rootVars()), status: { danger: ramp, ok: ramp, warn: ramp } }
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
    // compare nothing to nothing.
    expect(Object.keys(vars)).toHaveLength(19)
  })

  it("writes exactly today's :root values for the default palette", () => {
    const written = tokensToCssVars(tokensFromRoot(vars))
    const owned = Object.keys(written).sort()
    expect(owned).toHaveLength(16)
    // Every property it writes has to exist in :root with the same value: this is
    // the "the app renders today's pixels" half of AC3.4, decided against the
    // stylesheet rather than against a second copy of the palette.
    const expected = Object.fromEntries(
      Object.entries(vars).filter(([name]) => owned.includes(name))
    )
    expect(written).toEqual(expected)
  })

  it('emits channel triplets, never a hex', () => {
    // `tailwind.config.js` composes `rgb(var(--x) / <alpha-value>)`; a hex in the
    // variable is invalid at computed-value time, so every opacity-modified
    // utility is dropped silently with the build still green.
    const written = tokensToCssVars(tokensFromRoot(vars))
    for (const [name, value] of Object.entries(written)) {
      expect(value, name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
      expect(value, name).not.toContain('#')
    }
    expect(written['--ink-950']).toBe('13 11 9')
    expect(written['--ink-950']).not.toBe('#0d0b09')
  })

  it('leaves the shadow alphas and the colour scheme to slice 5, and status to slice 7a', () => {
    const written = tokensToCssVars(tokensFromRoot(vars))
    for (const name of Object.keys(written)) {
      expect(name).not.toMatch(/^--shadow-/)
      expect(name).not.toMatch(/^--status-/)
      expect(name).not.toBe('color-scheme')
    }
    // The three the apply path deliberately does not own, and why the count above
    // is 16 rather than 19.
    expect(vars['--shadow-a1']).toBe('0.5')
    expect(vars['--shadow-a2']).toBe('0.35')
    expect(vars['--shadow-a3']).toBe('0.6')
  })

  it('writes the status family when the set carries one, and only then', () => {
    const ramp = { '400': '#e5484d', '500': '#dc3545', '600': '#b02a37', on: '#ffffff' }
    const withStatus: ThemeTokens = {
      ...tokensFromRoot(vars),
      status: { danger: ramp, ok: ramp, warn: ramp }
    }
    const written = tokensToCssVars(withStatus)
    expect(Object.keys(written)).toHaveLength(28)
    expect(written['--status-danger-400']).toBe('229 72 77')
    expect(written['--status-ok-on']).toBe('255 255 255')
    expect(written['--status-warn-500']).toBe('220 53 69')
    expect(Object.keys(tokensToCssVars(tokensFromRoot(vars)))).toHaveLength(16)
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
    expect(Object.keys(set)).toHaveLength(16)
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
    expect(Object.keys(set)).toHaveLength(16)
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
    expect(Object.keys(set)).toHaveLength(16)
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
    expect(Object.keys(set)).toHaveLength(16)
    for (const name of STATUS_VARS) expect(set[name], name).toBeUndefined()
  })

  it('leaves the status family alone when the incoming set carries one', () => {
    // The complement: the removal above must be decided by the incoming set, not
    // by "always clear the twelve". A status-carrying set decides all twelve, so
    // the second apply writes them and takes nothing away.
    const { el, set } = recorder()
    applyTokens(tokensFromRoot(rootVars()), el)
    applyTokens(withStatus(), el)
    expect(Object.keys(set)).toHaveLength(28)
    for (const name of STATUS_VARS) expect(set[name], name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
    expect(set['--status-danger-400']).toBe('229 72 77')
    // And nothing outside the owned set was dropped by either apply.
    expect(Object.keys(set).filter((name) => !OWNED_CSS_VARS.includes(name))).toEqual([])
  })

  it('never writes or removes the slice-5 properties, on any switch', () => {
    // `--shadow-a1/a2/a3` and `color-scheme` are `:root`'s until slice 5, and the
    // reconcile must not reach outside the set it owns to clear them.
    const { el, set, removed } = recorder()
    applyTokens(withStatus(), el)
    applyTokens(tokensFromRoot(rootVars()), el)
    for (const name of SLICE5) {
      expect(set[name], name).toBeUndefined()
      expect(removed.has(name), name).toBe(false)
    }
  })
})

describe('OWNED_CSS_VARS — the names the apply path may write *and* take away', () => {
  it('is exactly the 28 names, and none of slice 5’s', () => {
    // Ownership is what the removal half runs on, so it is worth pinning: an
    // owned name the set never writes is removed on every apply, and a name this
    // path does not own is never touched — `--shadow-a1/a2/a3` and
    // `color-scheme` must keep whatever `src/index.css` declares.
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
    expect([...OWNED_CSS_VARS].sort()).toEqual([...palette, ...STATUS_VARS].sort())
    expect(new Set(OWNED_CSS_VARS).size).toBe(28)
    for (const name of SLICE5) expect(OWNED_CSS_VARS, name).not.toContain(name)
  })
})
