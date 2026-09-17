import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoredTheme, ThemeTokens, ThemeView } from '@shared/theme.types'
import { useThemeStore } from './theme.store'

/**
 * What the renderer holds, and where the pre-paint apply lives.
 *
 * The store is decided against a stubbed `window.Musaeum` (there is no preload
 * in a vitest run), and the boot ordering against the source of `src/main.tsx` —
 * the apply cannot be exercised here, because it is deliberately the one thing
 * that happens before React exists (no jsdom in this suite).
 */

const MAIN_TSX = join(process.cwd(), 'src', 'main.tsx')
const USE_THEME = join(process.cwd(), 'src', 'hooks', 'useTheme.ts')

const TOKENS: ThemeTokens = {
  ink: {
    '950': '#0d0b09',
    '900': '#14110d',
    '850': '#191511',
    '800': '#201b15',
    '700': '#2b241c',
    '600': '#3b3226',
    '500': '#4f4433'
  },
  parchment: { parchment: '#e9e1d2', parchment_dim: '#b3a78f', parchment_faint: '#7d7260' },
  gold: { '300': '#e8c987', '400': '#d4a24e', '500': '#c08f3a', '600': '#9c7028' },
  on_acc: '#0d0b09',
  scrim: '#0d0b09',
  shadow: 0.55,
  dark: true
}

function view(id: string): ThemeView {
  const active: StoredTheme = {
    id,
    name: id,
    author: 'test',
    provider: 'base16',
    variant: 'dark',
    sourcePath: null,
    engineVersion: 1,
    tokens: TOKENS,
    audits: [],
    adjustments: [],
    notes: []
  }
  return { active, defaultId: 'builtin:musaeum', stale: false }
}

/** `window.Musaeum`, reduced to the two members this store touches. */
function stubApi(set: (id: string) => Promise<ThemeView>): string[] {
  const calls: string[] = []
  vi.stubGlobal('window', {
    Musaeum: {
      theme: {
        set: (id: string) => {
          calls.push(id)
          return set(id)
        }
      }
    }
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  useThemeStore.setState({ view: null })
})

describe('theme store', () => {
  it('holds nothing until main has answered', () => {
    expect(useThemeStore.getState().view).toBeNull()
  })

  it('keeps the view main handed it', () => {
    const next = view('builtin:solarized-light')
    useThemeStore.getState().setView(next)
    expect(useThemeStore.getState().view).toEqual(next)
  })

  it('switches by asking main, and keeps what main returns', async () => {
    const calls = stubApi(async (id) => view(id))
    useThemeStore.getState().setView(view('builtin:musaeum'))

    const reason = await useThemeStore.getState().setTheme('builtin:gruvbox-dark-hard')

    expect(calls).toEqual(['builtin:gruvbox-dark-hard'])
    expect(reason).toBeNull()
    expect(useThemeStore.getState().view?.active.id).toBe('builtin:gruvbox-dark-hard')
  })

  it('reports a rejection as a reason and leaves the view alone', async () => {
    stubApi(async () => {
      throw new Error('No such theme: obsidian:Broken')
    })
    useThemeStore.getState().setView(view('builtin:musaeum'))

    const reason = await useThemeStore.getState().setTheme('obsidian:Broken')

    expect(reason).toBe('No such theme: obsidian:Broken')
    expect(useThemeStore.getState().view?.active.id).toBe('builtin:musaeum')
  })

  it('reports a non-Error rejection as a string rather than throwing', async () => {
    stubApi(async () => {
      throw 'nope'
    })
    const reason = await useThemeStore.getState().setTheme('whatever')
    expect(reason).toBe('nope')
  })
})

describe('AC3.5 (renderer half) — applied before the first render', () => {
  const main = readFileSync(MAIN_TSX, 'utf8')

  it('reads and applies the stored theme before createRoot(...).render(...)', () => {
    const read = main.indexOf('await window.Musaeum.theme.get()')
    const apply = main.indexOf('applyTokens(')
    const render = main.indexOf('createRoot(')
    expect(read).toBeGreaterThan(-1)
    expect(apply).toBeGreaterThan(read)
    expect(render).toBeGreaterThan(apply)
  })

  it('is failing-safe: the read is guarded and the render happens either way', () => {
    expect(main).toMatch(/try\s*\{[\s\S]*await window\.Musaeum\.theme\.get\(\)[\s\S]*\}\s*catch/)
    const caught = main.indexOf('catch')
    expect(caught).toBeGreaterThan(-1)
    expect(main.indexOf('createRoot(')).toBeGreaterThan(caught)
  })

  it('does not defer the apply to a mount effect', () => {
    // The mutation this guards: move the apply into `useTheme`'s mount effect,
    // which is one or more frames of the default palette before the swap.
    expect(main).not.toMatch(/useEffect|useLayoutEffect/)
  })

  it('seeds the store with the view it read, before rendering', () => {
    const seed = main.indexOf('useThemeStore.getState().setView(')
    expect(seed).toBeGreaterThan(main.indexOf('await window.Musaeum.theme.get()'))
    expect(seed).toBeLessThan(main.indexOf('createRoot('))
  })
})

describe('useTheme — everything after the first frame', () => {
  const hook = readFileSync(USE_THEME, 'utf8')

  it('subscribes to main’s themeChanged once', () => {
    expect(hook).toMatch(/window\.Musaeum\.on\.themeChanged\(/)
  })

  it('applies the active tokens from an effect', () => {
    expect(hook).toMatch(/useEffect\(\(\) => \{[\s\S]*applyTokens\(/)
  })
})
