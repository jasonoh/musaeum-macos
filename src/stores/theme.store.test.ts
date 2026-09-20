import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RejectedTheme,
  StoredTheme,
  ThemeImportResult,
  ThemeOption,
  ThemeTokens,
  ThemeView
} from '@shared/theme.types'
import { isBookFile } from '@shared/book.types'
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
const USE_DRAG_DROP = join(process.cwd(), 'src', 'hooks', 'useDragDrop.ts')
const APPEARANCE = join(process.cwd(), 'src', 'components', 'settings', 'AppearanceSection.tsx')

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

function view(id: string, options: ThemeOption[] = []): ThemeView {
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
  return { active, defaultId: 'builtin:musaeum', stale: false, options, folder: '/tmp/themes' }
}

/** One picker row, with only what a test cares about spelled out. */
function option(id: string, over: Partial<ThemeOption> = {}): ThemeOption {
  return {
    id,
    name: id,
    author: 'test',
    provider: 'base16',
    variant: 'dark',
    swatches: ['#0d0b09', '#201b15', '#e9e1d2', '#d4a24e', '#c08f3a'],
    active: false,
    stale: false,
    notes: [],
    sourcePath: null,
    ...over
  }
}

function imported(id: string, provider: ThemeOption['provider'] = 'base16') {
  return { id, name: id, provider, variant: 'dark' as const }
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

/** What each picker member may answer; an unstubbed one is a loud failure. */
interface PickerHandlers {
  importPaths?(paths: string[]): Promise<ThemeImportResult>
  importFromDialog?(): Promise<ThemeImportResult>
  scanFolder?(): Promise<ThemeImportResult>
  openFolder?(): Promise<void>
}

/**
 * The picker's own four members, recording that each was called and with what.
 *
 * Kept separate from `stubApi` rather than folded into it: the boot and switch
 * tests decide a two-member surface, and widening their stub would let a rename
 * of one of these silently pass as them.
 */
function stubPicker(handlers: PickerHandlers): { calls: string[]; paths: string[][] } {
  const calls: string[] = []
  const paths: string[][] = []
  const missing = (name: string) => {
    throw new Error(`${name} was not stubbed`)
  }
  vi.stubGlobal('window', {
    Musaeum: {
      theme: {
        importPaths: (p: string[]) => {
          calls.push('importPaths')
          paths.push(p)
          return handlers.importPaths?.(p) ?? missing('importPaths')
        },
        importFromDialog: () => {
          calls.push('importFromDialog')
          return handlers.importFromDialog?.() ?? missing('importFromDialog')
        },
        scanFolder: () => {
          calls.push('scanFolder')
          return handlers.scanFolder?.() ?? missing('scanFolder')
        },
        openFolder: () => {
          calls.push('openFolder')
          return handlers.openFolder?.() ?? missing('openFolder')
        }
      }
    }
  })
  return { calls, paths }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useThemeStore.setState({
    view: null,
    themeError: null,
    lastImport: null,
    importError: null,
    busy: false
  })
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

describe('theme store — the picker', () => {
  it('takes the whole view an import returned, so the rows cannot disagree with it', async () => {
    const next = view('builtin:musaeum', [
      option('builtin:musaeum', { name: 'Musaeum', active: true }),
      option('iterm:gruvbox-dark-hard', { name: 'Gruvbox Dark Hard', provider: 'itermcolors' })
    ])
    const result: ThemeImportResult = {
      view: next,
      imported: [imported('iterm:gruvbox-dark-hard', 'itermcolors')],
      rejected: []
    }
    const { calls, paths } = stubPicker({ importPaths: async () => result })
    useThemeStore.getState().setView(view('builtin:musaeum'))

    const reason = await useThemeStore.getState().importPaths(['/tmp/gruvbox.itermcolors'])

    expect(calls).toEqual(['importPaths'])
    expect(paths).toEqual([['/tmp/gruvbox.itermcolors']])
    expect(reason).toBeNull()
    expect(useThemeStore.getState().view).toEqual(next)
    expect(useThemeStore.getState().lastImport).toEqual(result)
    // D5: a row appearing is not a theme being applied
    expect(useThemeStore.getState().view?.active.id).toBe('builtin:musaeum')
  })

  it('keeps a batch’s rejections for the section to list, and not as a failure', async () => {
    const rejected: RejectedTheme[] = [
      { path: '/tmp/broken.yaml', reason: 'base16 palette has no base05' }
    ]
    const result: ThemeImportResult = {
      view: view('builtin:musaeum', [option('iterm:one'), option('iterm:two')]),
      imported: [imported('iterm:one', 'itermcolors'), imported('iterm:two', 'itermcolors')],
      rejected
    }
    stubPicker({ importPaths: async () => result })

    const reason = await useThemeStore.getState().importPaths(['/tmp/one.itermcolors'])

    // Four imported and one rejected is partial success, not an error (AC4.2)
    expect(reason).toBeNull()
    expect(useThemeStore.getState().importError).toBeNull()
    expect(useThemeStore.getState().lastImport?.rejected).toEqual(rejected)
    expect(useThemeStore.getState().lastImport?.imported).toHaveLength(2)
  })

  it('reports an import that failed outright as a reason, and leaves the rows alone', async () => {
    stubPicker({
      importPaths: async () => {
        throw new Error('The picker could not be opened')
      }
    })
    const before = view('builtin:musaeum', [option('builtin:musaeum', { active: true })])
    useThemeStore.getState().setView(before)

    const reason = await useThemeStore.getState().importPaths(['/tmp/one.yaml'])

    expect(reason).toBe('The picker could not be opened')
    expect(useThemeStore.getState().importError).toBe('The picker could not be opened')
    expect(useThemeStore.getState().view).toEqual(before)
    expect(useThemeStore.getState().busy).toBe(false)
  })

  it('scans the drop-box folder and takes the view the scan returned', async () => {
    const next = view('builtin:musaeum', [option('base16:tomorrow-night')])
    const { calls } = stubPicker({
      scanFolder: async () => ({
        view: next,
        imported: [imported('base16:tomorrow-night')],
        rejected: []
      })
    })

    const reason = await useThemeStore.getState().syncFolder()

    expect(calls).toEqual(['scanFolder'])
    expect(reason).toBeNull()
    expect(useThemeStore.getState().view?.options.map((o) => o.id)).toEqual([
      'base16:tomorrow-night'
    ])
  })

  it('reports a scan that failed as a reason rather than throwing', async () => {
    stubPicker({
      scanFolder: async () => {
        throw new Error('EACCES: permission denied')
      }
    })

    const reason = await useThemeStore.getState().syncFolder()

    expect(reason).toBe('EACCES: permission denied')
    expect(useThemeStore.getState().importError).toBe('EACCES: permission denied')
    expect(useThemeStore.getState().busy).toBe(false)
  })

  it('reports a reveal that failed as a reason rather than throwing', async () => {
    const { calls } = stubPicker({
      openFolder: async () => {
        throw 'no Finder here'
      }
    })

    const reason = await useThemeStore.getState().revealFolder()

    expect(calls).toEqual(['openFolder'])
    expect(reason).toBe('no Finder here')
    expect(useThemeStore.getState().importError).toBe('no Finder here')
  })

  it('holds a refused row’s reason until a click succeeds', async () => {
    stubApi(async () => {
      throw new Error('No such theme: base16:gone')
    })
    useThemeStore.getState().setView(view('builtin:musaeum'))

    await useThemeStore.getState().setTheme('base16:gone')

    expect(useThemeStore.getState().themeError).toEqual({
      id: 'base16:gone',
      reason: 'No such theme: base16:gone'
    })
    expect(useThemeStore.getState().view?.active.id).toBe('builtin:musaeum')

    stubApi(async (id) => view(id))
    expect(await useThemeStore.getState().setTheme('builtin:solarized-light')).toBeNull()
    expect(useThemeStore.getState().themeError).toBeNull()
  })

  it('marks the section busy for as long as a call is out', async () => {
    let answer!: (result: ThemeImportResult) => void
    stubPicker({
      importFromDialog: () =>
        new Promise<ThemeImportResult>((resolve) => {
          answer = resolve
        })
    })

    const pending = useThemeStore.getState().importFromDialog()
    expect(useThemeStore.getState().busy).toBe(true)

    answer({ view: view('builtin:musaeum'), imported: [], rejected: [] })
    expect(await pending).toBeNull()
    expect(useThemeStore.getState().busy).toBe(false)
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

describe('AC4.4 (renderer half) — a theme drop is not a book import', () => {
  const dragDrop = readFileSync(USE_DRAG_DROP, 'utf8')
  const section = readFileSync(APPEARANCE, 'utf8')

  it('leaves the window handler’s book-extension filter alone', () => {
    // The mutation this guards: add `.yaml`/`.itermcolors` to the book-file
    // list and a theme dropped on the library starts an import job on a file it
    // cannot read.
    //
    // The list is no longer in the drop handler — slice 3 of the library-IA
    // design derived it from `BookFormat` as `BOOK_FILE_EXTENSIONS` in
    // `@shared/book.types`, so the drop gate and the new file picker cannot
    // disagree. The case is decided against that shared module, which is now
    // where the mutation would be made; `.pdf` is asserted by name because
    // omitting it is the drift that produced the defect (PDF became first-class
    // in Phase 1.5 and this gate kept the old three).
    expect(isBookFile('dune.pdf')).toBe(true)
    for (const ext of ['yaml', 'yml', 'itermcolors', 'css']) {
      expect(isBookFile(`theme.${ext}`), ext).toBe(false)
    }
    // And the handler must still name no theme extension at all, shared list or
    // not: this is the file a dropped theme would reach first
    expect(dragDrop).not.toMatch(/itermcolors|\.yaml/)
  })

  it('hands the section’s drop to the theme importer, never to `import.addFiles`', () => {
    expect(section).toMatch(/Musaeum\.files\.getPathForFile/)
    expect(section).toMatch(/importPaths\(/)
    expect(section).not.toMatch(/import\.addFiles/)
  })
})

describe('AC4.5 (renderer half) — a row click applies without a save', () => {
  const section = readFileSync(APPEARANCE, 'utf8')

  it('applies through the theme store rather than the modal’s batched save', () => {
    // The mutation this guards: route the theme through `settings.save`, which
    // puts nothing on screen until the dialog is saved (AC4.5)
    expect(section).toMatch(/setTheme\(/)
    expect(section).not.toMatch(/Musaeum\.settings|settings\.save/)
  })

  it('needs no second interaction: no save chord in the section', () => {
    // Prose in the section's header names the chord it deliberately avoids, so
    // this looks for the machinery rather than the characters. It also covers
    // the filter box the fold added: `onKeyDown` is matched here, so a key
    // handler of any kind in this file reddens a criterion about the picker
    // growing no second interaction path.
    expect(section).not.toMatch(/metaKey|ctrlKey|onKeyDown|addEventListener\('keydown'/)
  })
})

describe('the appearance fold — what it may hide, and what it may not', () => {
  const section = readFileSync(APPEARANCE, 'utf8')
  const fold = section.indexOf('listOpen &&')

  it('leaves the list behind a real disclosure', () => {
    // The mutation this guards: render the list unconditionally and give the
    // summary row a chevron that does nothing.
    expect(fold).toBeGreaterThan(-1)
    expect(section.indexOf('{listOpen &&')).toBeGreaterThan(-1)
    expect(section).toMatch(/aria-expanded=\{listOpen\}/)
    expect(section).toMatch(/aria-controls=\{LIST_ID\}/)
    expect(section).toMatch(/id=\{LIST_ID\}/)
  })

  it('hides the list and nothing else — the way in stays above the fold', () => {
    // `tasks.md:166`'s constraint (a): "burying [the folder] under a hundred
    // rows is how a picker hides its own import". The mutation this guards:
    // move `<ImportControl>` or the drop-box row inside the `listOpen &&` block.
    // Asserted positionally on purpose — existence alone is satisfied by the
    // mutation, which is what makes the constraint worth a criterion.
    //
    // *Every* call site, not the first: the section renders the control from
    // both branches (the `!view` one and the list one), so an `indexOf` finds
    // the un-listable branch's render even after the view branch's has been
    // moved under the fold — measured, that is exactly the mutation that got
    // away in the campaign's first round.
    const calls = [...section.matchAll(/<ImportControl/g)].map((m) => m.index ?? -1)
    expect(fold).toBeGreaterThan(-1)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(Math.max(...calls)).toBeLessThan(fold)
    expect(section.indexOf('{view.folder}')).toBeLessThan(fold)
  })

  it('keeps the drag feedback above the fold, since the list can be the hidden half', () => {
    // Constraint (b): that sentence is in view precisely because the panel it
    // used to highlight can be a screen below the pointer.
    //
    // The claim is made in two steps and not by comparing the render site's
    // index with the fold's: `{dragging ? …}` lives inside `ImportControl`,
    // which is a *later* function in this file, so that comparison asserts the
    // opposite of what is true — this criterion's first version did exactly
    // that and its own run caught it. What matters is that the sentence belongs
    // to the control the fold may not cover, and is rendered there once:
    const def = section.indexOf('function ImportControl')
    const site = section.indexOf('{dragging ? DROP_HINT_ACTIVE')
    expect(def).toBeGreaterThan(-1)
    expect(site).toBeGreaterThan(def)
    expect(section.split('{dragging ? DROP_HINT_ACTIVE')).toHaveLength(2)
    expect(section).toMatch(/dragging \? DROP_HINT_ACTIVE : DROP_HINT/)
  })

  it('starts closed on every open, and remembers nothing between them', () => {
    // The mutation this guards: `useState(true)`, or persisting the fold —
    // either way the list the user sees is state whose cause they cannot see.
    expect(section).toMatch(/\[listOpen, setListOpen\] = useState\(false\)/)
    expect(section).not.toMatch(/localStorage|sessionStorage|\.persist\(/)
  })

  it('takes the summary row from the applied tokens, not from a list row', () => {
    // The mutation this guards: `view.options.find(o => o.active)?.swatches`,
    // which comes back empty whenever the active theme is not an option row.
    expect(section).toMatch(/appliedSwatches\(view\.active\.tokens\)/)
    expect(section).toMatch(
      /tokens\.ink\['950'\][\s\S]*tokens\.ink\['800'\][\s\S]*tokens\.parchment\.parchment[\s\S]*tokens\.gold\['400'\][\s\S]*tokens\.gold\['500'\]/
    )
  })

  it('names every extension its own drop filter accepts, and no other', () => {
    // A45's rule: the four sites must agree. The hint is the site that tells the
    // user what the filter takes, so a form added to the filter must appear in
    // the sentence — and a form the sentence offers must be one it accepts.
    const list = /const THEME_EXTENSIONS = \[([^\]]+)\]/.exec(section)?.[1] ?? ''
    const accepted = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1])
    const hint = /const DROP_HINT =\s*'([^']+)'/.exec(section)?.[1] ?? ''
    const named = [...hint.matchAll(/\.([a-z0-9]+)/g)].map((m) => `.${m[1]}`)

    expect(accepted).toHaveLength(4)
    expect(hint).not.toBe('')
    for (const ext of accepted) expect(named, ext).toContain(ext)
    for (const ext of named) expect(accepted, ext).toContain(ext)
  })
})
