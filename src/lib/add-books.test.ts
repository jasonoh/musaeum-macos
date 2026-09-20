import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { notifyError } from '@/lib/notify'
import { importBooksFromDialog } from './add-books'

vi.mock('@/lib/notify', () => ({ notifyError: vi.fn() }))

/**
 * Add Books, the app's on-ramp (design D5).
 *
 * The action is decided against a stubbed `window.Musaeum` (there is no preload
 * in a vitest run). The around it — the native File item, the ⌘O route, the
 * toolbar control — is decided by source walk, and the walks state their own
 * limit: driving `File ▸ Add Books…` needs assistive access to the macOS menu
 * bar, and the vitest Electron mock has no `Menu` at all, so nothing in this
 * suite presses the item. What a walk *can* prove is that the item exists, that
 * it sends a command the `MenuCommand` union names, and that the renderer routes
 * that command to the same function the toolbar control calls.
 */

/** `window.Musaeum`, reduced to the two members this action touches. */
function stubImport(handlers: {
  fromDialog(): Promise<string[]>
  addFiles?(paths: string[]): Promise<unknown>
}): string[][] {
  const imported: string[][] = []
  vi.stubGlobal('window', {
    Musaeum: {
      import: {
        fromDialog: () => handlers.fromDialog(),
        addFiles: (paths: string[]) => {
          imported.push(paths)
          return handlers.addFiles?.(paths) ?? Promise.resolve([])
        }
      }
    }
  })
  return imported
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(notifyError).mockClear()
})

describe('importBooksFromDialog — what the picker hands back', () => {
  const PATHS = ['/tmp/Books/dune.epub', '/tmp/Books/pump.epub', '/tmp/Books/scan.pdf']

  it('imports exactly the paths the picker answered with, in one batch', async () => {
    const imported = stubImport({ fromDialog: async () => PATHS })
    await importBooksFromDialog()
    // One call, not one per file: the pipeline gates duplicates and reports
    // progress per job, so three separate calls would be three jobs
    expect(imported).toEqual([PATHS])
  })

  it('does nothing at all when the dialog is cancelled', async () => {
    // The handler answers a cancelled dialog with an empty list, so this is the
    // only cancelled-state check there is — and a no-op, not an error
    const imported = stubImport({ fromDialog: async () => [] })
    await importBooksFromDialog()
    expect(imported).toEqual([])
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('reports a failed picker on the toast surface, not in the console', async () => {
    stubImport({ fromDialog: async () => Promise.reject(new Error('Library is offline')) })
    await importBooksFromDialog()
    expect(vi.mocked(notifyError).mock.calls[0][0]).toBeInstanceOf(Error)
  })

  it('reports a failed import the same way', async () => {
    const imported = stubImport({
      fromDialog: async () => PATHS,
      addFiles: async () => Promise.reject(new Error('No book file found'))
    })
    await importBooksFromDialog()
    expect(imported).toEqual([PATHS])
    expect(vi.mocked(notifyError)).toHaveBeenCalledTimes(1)
  })
})

const MENU = join(process.cwd(), 'electron', 'main', 'services', 'menu.ts')
const COMMANDS = join(process.cwd(), 'src', 'hooks', 'useMenuCommands.ts')
const API_TYPES = join(process.cwd(), 'src', 'types', 'api.types.ts')
const TOOLBAR = join(process.cwd(), 'src', 'components', 'layout', 'Toolbar.tsx')
const APP = join(process.cwd(), 'src', 'App.tsx')
const LIBRARY_IPC = join(process.cwd(), 'electron', 'main', 'ipc', 'library.ts')

/** The submenu's own source, so an assertion about it can't be satisfied by an
 *  unrelated item elsewhere in the template. */
function submenuSource(src: string, name: string): string {
  const start = src.indexOf(`const ${name}: MenuItemConstructorOptions`)
  const end = src.indexOf('\n  }\n', start)
  return src.slice(start, end === -1 ? src.length : end)
}

describe('File ▸ Add Books… (AC16) — the native half, by source walk', () => {
  const menu = readFileSync(MENU, 'utf8')
  const apiTypes = readFileSync(API_TYPES, 'utf8')
  const commands = readFileSync(COMMANDS, 'utf8')

  it('declares a File submenu and installs it in the template', () => {
    const name = menu.match(/const (\w+): MenuItemConstructorOptions = \{\s*label: 'File'/)![1]
    // A declared-but-unused submenu is the mutation that matters here: the
    // template is what `Menu.buildFromTemplate` receives, and nothing else in
    // this file would notice the item going missing
    expect(menu).toMatch(new RegExp(`return \\[[^\\]]*\\b${name}\\b`))
    expect(menu.indexOf(`const ${name}`)).toBeLessThan(menu.indexOf("label: 'Edit'"))
  })

  it('carries Add Books… with ⌘O, sending one menu command', () => {
    const file = submenuSource(menu, 'fileMenu')
    expect(file).toMatch(/label: 'Add Books…'/)
    expect(file).toMatch(/accelerator: 'CmdOrCtrl\+O'/)
    expect(file).toMatch(/click: command\('add-books'\)/)
    // The item sends and does not act — `menu-and-branding.md`'s rule
    expect(file).not.toMatch(/showOpenDialog|import\(/)
  })

  it('sends only commands the MenuCommand union names', () => {
    const start = apiTypes.indexOf('export type MenuCommand')
    const union = apiTypes.slice(start, apiTypes.indexOf('\n\nexport ', start))
    const sent = [...menu.matchAll(/command\('([^']+)'\)/g)].map((m) => m[1])
    expect(sent).toContain('add-books')
    for (const cmd of sent) expect(union, cmd).toContain(`'${cmd}'`)
  })

  it('routes it in the renderer, from inside the menu-command subscription', () => {
    const arm = commands.indexOf("cmd === 'add-books'")
    expect(arm).toBeGreaterThan(commands.indexOf('window.Musaeum.on.menuCommand'))
    // ⌘O runs the toolbar menu's first item, not a picker of its own: one
    // function behind both doors is what keeps them from drifting apart
    expect(commands).toMatch(/importBooksFromDialog\(\)/)
  })
})

describe('the Add Books control (AC17) — one menu, two on-ramps', () => {
  const toolbar = readFileSync(TOOLBAR, 'utf8')

  it('offers both items, the first of them the picker', () => {
    expect(toolbar).toMatch(/label="Import files…"/)
    expect(toolbar).toMatch(/label="Migrate from Calibre…"/)
    // The same function ⌘O reaches, so the shortcut cannot become a second
    // import path with its own behaviour
    expect(toolbar).toMatch(/importBooksFromDialog\(\)/)
  })

  it('opens the wizard the app actually renders for that modal', () => {
    expect(toolbar).toMatch(/openModal\('migration'\)/)
    // Read-only: the toolbar's second item is only real if this is how the
    // wizard is mounted (design D4 — the same modal the empty view opens)
    expect(readFileSync(APP, 'utf8')).toMatch(/modal === 'migration' && <MigrationWizard/)
  })

  it('is its own control, with no store holding the menu open', () => {
    // The design's shape rule: the menu's open/closed state is local to the
    // control — a store field would be state the once-built native menu cannot
    // see anyway
    expect(toolbar).toMatch(/useState/)
    expect(toolbar).not.toMatch(/setAddBooksMenu|addBooksMenuOpen/)
  })
})

describe('the picker handler (AC18) — the filter is the shared list', () => {
  const library = readFileSync(LIBRARY_IPC, 'utf8')

  it('builds its filter from the shared derivation, not a literal array', () => {
    expect(library).toMatch(/import \{ bookFileFilter \} from '@shared\/book\.types'/)
    expect(library).toMatch(/filters: \[bookFileFilter\(\)\]/)
    // A hand-written `extensions: [...]` here would be the sixth declaration of
    // what a book file is — the copy a new format is most likely to miss
    expect(library).not.toMatch(/extensions:/)
  })

  it('is a multi-select open-file dialog, and answers [] when cancelled', () => {
    expect(library).toMatch(/properties: \['openFile', 'multiSelections'\]/)
    expect(library).toMatch(/result\.canceled \? \[\] : result\.filePaths/)
  })

  it('returns paths to the renderer rather than importing them itself', () => {
    // Invariant 8: the handler is a thin wrapper. Importing here would put a
    // decision in the handler and make the batch the renderer starts invisible
    expect(library).toMatch(/handle\('import:fromDialog', async \(\): Promise<string\[\]> => \{/)
    expect(library).not.toMatch(/import:fromDialog'[\s\S]{0,600}importer\.addFiles/)
  })
})
