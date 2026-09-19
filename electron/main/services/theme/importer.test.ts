import { createHash } from 'crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { app } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThemeIr, ThemeTokens } from '@shared/theme.types'
import { closeDb, getConfig, getDb, setConfig } from '../db'
import { deriveTheme, loadThemeFile, THEME_ENGINE_VERSION } from './index'
import { importPaths, scanFolder, withThemeView } from './importer'
import {
  OBSIDIAN_THEME_FILE,
  type ResolvedObsidianFile,
  type ResolvedObsidianVariant
} from './parse/obsidian'
import {
  DEFAULT_THEME_ID,
  getThemeView,
  MUSAEUM_DEFAULT_TOKENS,
  readLibrary,
  setTheme,
  themeFolder,
  THEME_LIBRARY_KEY
} from './store'

/**
 * Slice 4's import pipeline, end to end on real files.
 *
 * Everything here goes through the real engine and a real `app_config` (the
 * throwaway `userData` the Electron mock hands out): an import's whole job is the
 * boundary between bytes on disk and a row the picker can offer, and a stubbed
 * parser or a stubbed library would decide none of it.
 *
 * The provider files are the ones the port was tested against — the vendored
 * corpus for base16 and the two committed `.itermcolors` fixtures — because the
 * pipeline's lossy steps (the iTerm ramp reconstruction, the floor walks) only
 * exist on palettes that were not written for us.
 */

const THEME_DIR = join(process.cwd(), 'electron', 'main', 'services', 'theme')
const BUILTIN = join(THEME_DIR, 'builtin')
const FIXTURES = join(process.cwd(), 'test', 'fixtures', 'theme')

const GRUVBOX_YAML = join(BUILTIN, 'gruvbox-dark-hard.yaml')
const NORD_YAML = join(BUILTIN, 'nord.yaml')
const SOLARIZED_YAML = join(BUILTIN, 'solarized-light.yaml')
const GRUVBOX_ITERM = join(FIXTURES, 'gruvbox.itermcolors')
const NORD_ITERM = join(FIXTURES, 'nord.itermcolors')

/** A truncated plist — the shape a half-written or half-synced provider file has. */
const BROKEN_ITERM =
  '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n<key>Ansi 0 Color</key>\n'

let scratchDir: string | null = null

/** A scratch directory for the files a case has to write. Removed in `afterEach`. */
function scratch(): string {
  scratchDir ??= mkdtempSync(join(tmpdir(), 'musaeum-theme-import-'))
  return scratchDir
}

/** A real file with the bytes of `from`, at `name` inside the scratch directory. */
function scratchCopy(from: string, name: string): string {
  const to = join(scratch(), name)
  copyFileSync(from, to)
  return to
}

function writeScratch(name: string, text: string): string {
  const to = join(scratch(), name)
  writeFileSync(to, text)
  return to
}

beforeEach(() => {
  closeDb()
  const dir = app.getPath('userData')
  for (const f of ['musaeum.db', 'musaeum.db-wal', 'musaeum.db-shm']) {
    rmSync(join(dir, f), { force: true })
  }
  // The drop-box starts absent, which is also the state the "nothing creates it"
  // case needs to observe.
  rmSync(themeFolder(), { recursive: true, force: true })
})

afterEach(() => {
  if (scratchDir !== null) rmSync(scratchDir, { recursive: true, force: true })
  scratchDir = null
})

/** The engine's own read of a file, so a case can assert against it, not a copy. */
function irOf(path: string): ThemeIr {
  const loaded = loadThemeFile(path)
  if (!loaded.ok) throw new Error(`${path} did not load: ${loaded.reason}`)
  return loaded.ir
}

function tokensOf(path: string): ThemeTokens {
  const derived = deriveTheme(irOf(path))
  if (!derived.ok) throw new Error(`${path} did not derive`)
  return derived.tokens
}

/** One row of the view, or a failure naming what is missing. */
function rowOf(id: string): ReturnType<typeof getThemeView>['options'][number] {
  const row = getThemeView().options.find((option) => option.id === id)
  if (!row) throw new Error(`no option row for ${id}`)
  return row
}

/**
 * Everything the folder is, as one string: every entry's name, size and
 * modification time. AC4.3's decider for "the app never writes into this folder"
 * — a copy, a rename or a rewrite moves this hash, and nothing else does.
 */
function directoryHash(dir: string): string {
  const entries = readdirSync(dir)
    .sort()
    .map((name) => {
      const stat = statSync(join(dir, name))
      return `${name}:${stat.size}:${stat.mtimeMs}`
    })
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

// --- AC4.1: the provider types import, and each becomes a row -----------------

describe('AC4.1 — a base16 scheme and an iTerm2 scheme both import', () => {
  it('imports one of each, keyed by the file’s stem and the provider it parsed as', async () => {
    const batch = await importPaths([GRUVBOX_YAML, GRUVBOX_ITERM])

    expect(batch.rejected).toEqual([])
    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'base16:gruvbox-dark-hard',
      'iterm:gruvbox'
    ])
    expect(batch.imported.map((theme) => theme.provider)).toEqual(['base16', 'itermcolors'])
    expect(batch.imported.map((theme) => theme.variant)).toEqual(['dark', 'dark'])
    // The name is the palette's own (`name:` for base16, the file's stem for
    // iTerm, which carries no name at all) — never the id restated.
    expect(batch.imported.map((theme) => theme.name)).toEqual([
      irOf(GRUVBOX_YAML).name,
      basename(GRUVBOX_ITERM, '.itermcolors')
    ])
  })

  it('gives each imported theme a row with five swatches, a provider and a variant', async () => {
    await importPaths([GRUVBOX_YAML, GRUVBOX_ITERM])

    for (const [id, path] of [
      ['base16:gruvbox-dark-hard', GRUVBOX_YAML],
      ['iterm:gruvbox', GRUVBOX_ITERM]
    ] as const) {
      const row = rowOf(id)
      const tokens = tokensOf(path)

      expect(row.swatches).toHaveLength(5)
      for (const swatch of row.swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/)
      // The five are the derived set's own values in the frozen order, not a
      // second palette assembled for the picker.
      expect(row.swatches).toEqual([
        tokens.ink['950'],
        tokens.ink['800'],
        tokens.parchment.parchment,
        tokens.gold['400'],
        tokens.gold['500']
      ])
      expect(row.name).toBe(irOf(path).name)
      expect(row.provider).toBe(irOf(path).source)
      expect(row.variant).toBe('dark')
      expect(row.author).toBe(irOf(path).author)
      expect(row.sourcePath).toBe(path)
      // Importing is not activating.
      expect(row.active).toBe(false)
      expect(row.stale).toBe(false)
    }
  })

  it('carries the iTerm file’s own lossy note, which is the disclosure the row shows', async () => {
    await importPaths([GRUVBOX_ITERM])
    // A terminal file has no base01–03, so the ramp above the canvas is inferred
    // — the one thing a user looking at two grays of the same scheme needs told.
    expect(rowOf('iterm:gruvbox').notes.some((note) => /ramp inferred/.test(note))).toBe(true)
  })

  it('imports a light scheme as a light row', async () => {
    const batch = await importPaths([SOLARIZED_YAML])

    expect(batch.imported.map((theme) => theme.variant)).toEqual(['light'])
    const row = rowOf('base16:solarized-light')
    expect(row.variant).toBe('light')
    // The canvas swatch is the light one — a row's first swatch is what the app
    // would paint behind everything.
    expect(row.swatches[0]).toBe('#fdf6e3')
  })
})

// --- AC4.2: a batch is validated member by member -----------------------------

describe('AC4.2 — import is validated before it is stored', () => {
  /**
   * The batch's five files. The malformed member sits in the *middle*, so a
   * batch that stops at the first failure is visible in the count (one imported
   * instead of four) rather than only in the exception it would have to throw.
   */
  function fiveFiles(): { paths: string[]; broken: string } {
    const broken = writeScratch('broken.itermcolors', BROKEN_ITERM)
    return { paths: [GRUVBOX_YAML, broken, NORD_YAML, SOLARIZED_YAML, GRUVBOX_ITERM], broken }
  }

  it('imports four of five and reports the malformed member by path and reason', async () => {
    const { paths, broken } = fiveFiles()
    const batch = await importPaths(paths)

    expect(batch.imported).toHaveLength(4)
    expect(batch.rejected).toHaveLength(1)
    expect(batch.rejected[0].path).toBe(broken)
    // The reason is the engine's own string, not a summary written here: the
    // row the user reads has to be the failure the parser actually had.
    const loaded = loadThemeFile(broken)
    if (loaded.ok) throw new Error('expected the broken fixture to fail to load')
    expect(batch.rejected[0].reason).toBe(loaded.reason)
    expect(batch.rejected[0].reason).toMatch(/plist/)
  })

  it('makes the four usable: each resolves through setTheme and renders its own canvas', async () => {
    const { paths } = fiveFiles()
    const batch = await importPaths(paths)

    expect(batch.imported).toHaveLength(4)
    for (const imported of batch.imported) {
      const result = setTheme(imported.id)
      if (!result.ok) throw new Error(`${imported.id} was rejected: ${result.reason}`)
      expect(result.view.active.id).toBe(imported.id)
      expect(result.view.stale).toBe(false)
      // The row renders the palette of the file it came from — each of the four
      // is its own derivation, not one result shared four ways.
      expect(paths).toContain(result.view.active.sourcePath)
      expect(result.view.active.tokens.ink['950']).toBe(
        tokensOf(result.view.active.sourcePath ?? '').ink['950']
      )
    }
  })

  it('writes nothing for the failed member and keeps the four in the library', async () => {
    const batch = await importPaths(fiveFiles().paths)

    // The rejected file is not a row, in the view or in storage.
    const ids = readLibrary().map((record) => record.id)
    expect(ids).toHaveLength(4)
    expect(ids.some((id) => id.includes('broken'))).toBe(false)
    expect(getThemeView().options.some((row) => row.id.includes('broken'))).toBe(false)
    expect(batch.imported.every((theme) => ids.includes(theme.id))).toBe(true)
  })

  it('reports in input order, so a rejection lines up with the file it names', async () => {
    const paths = [NORD_YAML, writeScratch('broken.itermcolors', BROKEN_ITERM), GRUVBOX_YAML]
    const batch = await importPaths(paths)

    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'base16:nord',
      'base16:gruvbox-dark-hard'
    ])
    expect(batch.rejected.map((row) => row.path)).toEqual([paths[1]])
  })

  it('answers a path it cannot read as that file’s rejection rather than throwing', async () => {
    const missing = join(scratch(), 'not-there.yaml')
    // Slice 6 made this door async, and an async function cannot throw at its
    // caller — so `not.toThrow()` would now be true of *every* input, including
    // ones that should be rejected. The assertion is the value it answers.
    const alone = await importPaths([missing])
    expect(alone.imported).toEqual([])
    expect(alone.rejected.map((row) => row.path)).toEqual([missing])
    const batch = await importPaths([missing, GRUVBOX_YAML])
    expect(batch.rejected.map((row) => row.path)).toEqual([missing])
    expect(batch.rejected[0].reason).toContain(missing)
    // The good member beside it still imported.
    expect(batch.imported.map((theme) => theme.id)).toEqual(['base16:gruvbox-dark-hard'])
  })
})

// --- AC4.3: the drop-box directory -------------------------------------------

describe('AC4.3 — the drop-box directory works and is never written to', () => {
  /** Three provider files in the folder: two fixtures, one of them renamed. */
  function dropThreeFiles(): void {
    mkdirSync(themeFolder(), { recursive: true })
    copyFileSync(GRUVBOX_ITERM, join(themeFolder(), 'gruvbox.itermcolors'))
    copyFileSync(NORD_ITERM, join(themeFolder(), 'nord.itermcolors'))
    // The same palette under another stem, which is the stem-keyed id rule (D1)
    // stated as a file: a rename in the folder is a second theme, not an update.
    copyFileSync(GRUVBOX_ITERM, join(themeFolder(), 'gruvbox-proton.itermcolors'))
  }

  it('scans three dropped files into three new rows', async () => {
    dropThreeFiles()
    const before = getThemeView().options.length

    const batch = await scanFolder()

    expect(batch.rejected).toEqual([])
    // Sorted file names — `gruvbox-proton.itermcolors` sorts before
    // `gruvbox.itermcolors` because `-` precedes `.` — so the reported order is
    // the folder's own, not an order this scan invented.
    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'iterm:gruvbox-proton',
      'iterm:gruvbox',
      'iterm:nord'
    ])
    const view = getThemeView()
    expect(view.options).toHaveLength(before + 3)
    for (const theme of batch.imported) {
      expect(view.options.map((row) => row.id)).toContain(theme.id)
      expect(rowOf(theme.id).swatches).toHaveLength(5)
    }
  })

  it('leaves the directory byte-identical: same entries, sizes and mtimes', async () => {
    dropThreeFiles()
    const folder = themeFolder()
    // Non-vacuity: the hash covers three entries, so an empty or single-entry
    // directory cannot make the two reads agree for free.
    expect(readdirSync(folder)).toHaveLength(3)
    const before = directoryHash(folder)

    await scanFolder()

    expect(readdirSync(folder)).toHaveLength(3)
    expect(directoryHash(folder)).toBe(before)
    // And non-vacuity for the check itself: the hash *does* move when anything in
    // the folder changes, which is the mutation (a copy or a normalization
    // during import) this criterion exists to catch.
    writeFileSync(join(folder, 'touched.yaml'), 'name: "Touched"\n')
    expect(directoryHash(folder)).not.toBe(before)
  })

  it('does not create the folder itself', async () => {
    // A missing folder is an empty scan rather than a failure, and the door is
    // async now — so the assertion is the batch it answers.
    expect(await scanFolder()).toEqual({ imported: [], rejected: [] })
    // The `mkdir` belongs to the Reveal control: a read that created the folder
    // would put an empty directory in the user's Application Support, and
    // AC4.3's "never written to" would have nothing to hash.
    expect(() => statSync(themeFolder())).toThrow()
  })

  it('ignores every entry that is not a theme file, silently', async () => {
    mkdirSync(themeFolder(), { recursive: true })
    copyFileSync(GRUVBOX_YAML, join(themeFolder(), 'gruvbox-dark-hard.yaml'))
    copyFileSync(NORD_ITERM, join(themeFolder(), 'nord.itermcolors'))
    writeFileSync(join(themeFolder(), 'README.md'), 'drop provider files here\n')
    writeFileSync(join(themeFolder(), '.DS_Store'), '\u0000')
    // **Inverted from slice 5's reading of this line.** `.css` *is* a scannable
    // extension as of slice 6, so what keeps the listing quiet is no longer "this
    // build cannot read stylesheets" — it is D7's rule that an Obsidian theme is
    // a *folder* holding `theme.css`, and a stylesheet at the drop box's own
    // level sits in no such folder (the folder that would name it would be the
    // drop box itself). The assertion below is unchanged in shape and opposite in
    // cause: the silence is now a decision the scan makes, not a consequence of
    // the extension set.
    writeFileSync(join(themeFolder(), 'notes.css'), ':root { --x: #fff; }\n')
    // A *directory* under a theme extension is not a file, so it is skipped too.
    mkdirSync(join(themeFolder(), 'backup.yaml'))

    const batch = await scanFolder()

    expect(batch.rejected).toEqual([])
    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'base16:gruvbox-dark-hard',
      'iterm:nord'
    ])
    // Stated positively rather than left to the two assertions above: the loose
    // stylesheet is neither a row nor a reason.
    expect(batch.imported.some((theme) => theme.id.includes('notes'))).toBe(false)
    expect(batch.rejected.some((row) => row.path.endsWith('notes.css'))).toBe(false)
  })

  it('reports a supported file that fails to parse, and still imports its neighbours', async () => {
    mkdirSync(themeFolder(), { recursive: true })
    copyFileSync(NORD_ITERM, join(themeFolder(), 'nord.itermcolors'))
    writeFileSync(join(themeFolder(), 'half.itermcolors'), BROKEN_ITERM)

    const batch = await scanFolder()

    expect(batch.imported.map((theme) => theme.id)).toEqual(['iterm:nord'])
    expect(batch.rejected.map((row) => row.path)).toEqual([join(themeFolder(), 'half.itermcolors')])
  })

  it('does not import the same file twice on a second scan', async () => {
    dropThreeFiles()
    await scanFolder()
    const again = await scanFolder()

    // The rows existed already, so nothing is *new* — but a rescan must not
    // duplicate a row either: the id is the key, not the scan.
    expect(again.imported).toHaveLength(3)
    expect(readLibrary()).toHaveLength(3)
    expect(getThemeView().options.filter((row) => row.id === 'iterm:gruvbox')).toHaveLength(1)
  })
})

// --- Re-import: upsert, not duplicate ----------------------------------------

describe('re-importing a file upserts the row it already has', () => {
  it('does not add a second row for the same file', async () => {
    const first = await importPaths([GRUVBOX_ITERM])
    const second = await importPaths([GRUVBOX_ITERM])

    expect(first.imported).toHaveLength(1)
    expect(second.imported).toHaveLength(1)
    expect(readLibrary()).toHaveLength(1)
    expect(getThemeView().options.filter((row) => row.id === 'iterm:gruvbox')).toHaveLength(1)
  })

  it('replaces the row in place when the file’s bytes changed', async () => {
    const path = scratchCopy(GRUVBOX_YAML, 'palette.yaml')
    await importPaths([path])
    const before = rowOf('base16:palette')
    expect(before.variant).toBe('dark')

    // The same file name, different scheme — what editing a dropped file looks
    // like from here. The id is the stem, so this is the *same* theme updated.
    copyFileSync(SOLARIZED_YAML, path)
    const batch = await importPaths([path])

    expect(batch.rejected).toEqual([])
    expect(readLibrary()).toHaveLength(1)
    const after = rowOf('base16:palette')
    expect(after.variant).toBe('light')
    expect(after.swatches[0]).toBe(tokensOf(SOLARIZED_YAML).ink['950'])
    expect(after.swatches).not.toEqual(before.swatches)
  })
})

// --- D2: the namespaces are disjoint -----------------------------------------

describe('D2 — an imported id cannot shadow a built-in', () => {
  it('offers an imported copy of a vendored scheme beside the built-in of the same name', async () => {
    await importPaths([GRUVBOX_YAML])

    // Both rows exist, and they are different themes: one is the inlined corpus
    // entry with no file behind it, the other is the imported file.
    const imported = rowOf('base16:gruvbox-dark-hard')
    const builtin = rowOf('builtin:gruvbox-dark-hard')
    expect(imported.id).not.toBe(builtin.id)
    expect(imported.sourcePath).toBe(GRUVBOX_YAML)
    expect(builtin.sourcePath).toBeNull()

    // And resolving each one gives its own record rather than the other's.
    const fromImport = setTheme('base16:gruvbox-dark-hard')
    if (!fromImport.ok) throw new Error(`imported id was rejected: ${fromImport.reason}`)
    expect(fromImport.view.active.sourcePath).toBe(GRUVBOX_YAML)

    const fromRegistry = setTheme('builtin:gruvbox-dark-hard')
    if (!fromRegistry.ok) throw new Error(`built-in id was rejected: ${fromRegistry.reason}`)
    expect(fromRegistry.view.active.sourcePath).toBeNull()
    expect(fromRegistry.view.active.engineVersion).toBe(THEME_ENGINE_VERSION)
  })

  it('cannot replace the built-in default, even when the file is named for it', async () => {
    const path = scratchCopy(GRUVBOX_YAML, 'musaeum.yaml')
    const batch = await importPaths([path])

    // The file's id is namespaced by its provider, so it cannot spell the
    // default's id (`builtin:musaeum`) — a file named after the app imports as
    // one more theme rather than taking the default's identity.
    expect(batch.imported.map((theme) => theme.id)).toEqual(['base16:musaeum'])
    const row = rowOf('base16:musaeum')
    expect(row.provider).toBe('base16')
    expect(rowOf(DEFAULT_THEME_ID).provider).toBe('native')

    const imported = setTheme('base16:musaeum')
    expect(imported.ok).toBe(true)
    expect(getConfig('theme_id')).toBe('base16:musaeum')

    // The default is still the default, from its authored constant.
    const backToDefault = setTheme(DEFAULT_THEME_ID)
    if (!backToDefault.ok) throw new Error('the default was rejected')
    expect(backToDefault.view.active.provider).toBe('native')
    expect(backToDefault.view.active.tokens).toEqual(MUSAEUM_DEFAULT_TOKENS)
    expect(getConfig('theme_id')).toBeNull()
  })
})

// --- D10 (the answered view) and D6 (a write that cannot land) ----------------

/**
 * The composition the IPC handlers use, and the one file-level write failure a
 * batch has to survive.
 *
 * Both live here rather than in an `ipc/theme.test.ts` because the handler layer
 * has no harness — `ipcMain.handle` is a no-op in the Electron mock, so a test
 * could not see a handler's return value at all — which is exactly why the
 * ordering bug these cases decide shipped in the first place: the handler answered
 * `{ view: getThemeView(), ...await importPaths(paths) }`, left-to-right property
 * evaluation read the view *before* the import, and the row the user had just
 * imported was missing from the list until some later interaction.
 */
describe('D10 — an import answer carries the list it just changed', () => {
  it('heads a batch with a view that already contains the imported row', async () => {
    const file = scratchCopy(GRUVBOX_YAML, 'fresh-theme.yaml')
    expect(
      getThemeView()
        .options.map((option) => option.id)
        .includes('base16:fresh-theme')
    ).toBe(false)

    const result = withThemeView(await importPaths([file]))

    expect(result.imported.map((theme) => theme.id)).toEqual(['base16:fresh-theme'])
    const row = result.view.options.find((option) => option.id === 'base16:fresh-theme')
    if (!row) throw new Error('the answered view did not carry the row it had just imported')
    expect(row.swatches).toHaveLength(5)
    // And the view is the *whole* view, not a list of the imported ids: the
    // renderer replaces what it is showing with this (D10).
    expect(result.view.options.length).toBeGreaterThan(result.imported.length)
  })

  it('also answers an empty batch with a view, so a cancelled dialog is harmless', async () => {
    const result = withThemeView({ imported: [], rejected: [] })
    expect(result.imported).toEqual([])
    expect(result.view.options.length).toBeGreaterThan(0)
  })

  it('keeps the handlers composing through it, rather than an inline literal', async () => {
    // A source walk, deliberately: the regression this guards cannot be seen by a
    // behaviour test (no handler harness), and an inline
    // `{ view: getThemeView(), ...await importPaths(paths) }` reads the view first and
    // silently ships the bug again. Matching the *call* is the only instrument
    // that exists here; `withThemeView`'s own case above decides the ordering.
    const ipc = readFileSync(join(process.cwd(), 'electron', 'main', 'ipc', 'theme.ts'), 'utf8')
    // Comment lines are dropped first: this file's own header quotes the broken
    // shape to explain why it is broken, and a walk that cannot tell a comment from
    // code would fail on its own documentation.
    const code = ipc
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
      })
      .join('\n')

    expect(code).toMatch(/withThemeView\(/)
    expect(code).not.toMatch(/view:\s*getThemeView\(\)/)
  })
})

describe('D6 — a batch survives a write that cannot land', () => {
  it('reports the file whose write was refused, and keeps the ones before it', async () => {
    const first = scratchCopy(GRUVBOX_YAML, 'first-theme.yaml')
    const second = scratchCopy(NORD_YAML, 'second-theme.yaml')
    // Refuse only the write that carries the *second* record: the first file's
    // write mentions only its own id, so it lands. One transaction per file is what
    // makes that possible — a single transaction for the batch would lose the first
    // file with the second.
    const when = "NEW.key = 'theme_library' AND NEW.value LIKE '%base16:second-theme%'"
    getDb().exec(
      `CREATE TRIGGER library_insert_poison BEFORE INSERT ON app_config WHEN ${when} BEGIN SELECT RAISE(ABORT, 'poisoned by the test'); END;
       CREATE TRIGGER library_update_poison BEFORE UPDATE ON app_config WHEN ${when} BEGIN SELECT RAISE(ABORT, 'poisoned by the test'); END;`
    )

    const batch = await importPaths([first, second])

    expect(batch.imported.map((theme) => theme.id)).toEqual(['base16:first-theme'])
    expect(batch.rejected.map((rejection) => rejection.path)).toEqual([second])
    expect(batch.rejected[0].reason).toContain('poisoned by the test')
    // The first file is imported and usable: a batch is not one transaction, and a
    // failure is reported per path rather than thrown at the caller (#12).
    expect(readLibrary().map((theme) => theme.id)).toEqual(['base16:first-theme'])
    const applied = setTheme('base16:first-theme')
    expect(applied.ok).toBe(true)
  })
})

describe('D5 — importing never activates a theme', () => {
  it('leaves the app on the theme it was on', async () => {
    mkdirSync(themeFolder(), { recursive: true })
    copyFileSync(NORD_ITERM, join(themeFolder(), 'nord.itermcolors'))
    const started = setTheme('builtin:solarized-light')
    if (!started.ok) throw new Error(`built-in:solarized-light was rejected: ${started.reason}`)
    const stored = getConfig('theme_id')

    await importPaths([GRUVBOX_YAML, GRUVBOX_ITERM, SOLARIZED_YAML])
    await scanFolder()

    expect(getConfig('theme_id')).toBe(stored)
    expect(getThemeView().active.id).toBe('builtin:solarized-light')
    expect(
      getThemeView()
        .options.filter((row) => row.active)
        .map((row) => row.id)
    ).toEqual(['builtin:solarized-light'])
  })
})

// --- Slice 6: the Obsidian pipeline, with the resolver faked ------------------

/**
 * Slice 6's import rules, decided without Electron.
 *
 * The resolver is the one part of the pipeline that needs a window, so it is a
 * parameter (`ImportOptions.resolveCss`) and every case below passes a fake. What
 * that leaves decidable here is everything the *pipeline* owns: that a `.css` is
 * keyed by its folder, that a two-entry file writes two ids, that a loose
 * stylesheet is silent in a scan and a reason in a drag, and that an Obsidian row
 * survives an engine-version bump without being re-read.
 *
 * The palettes the fakes answer with are the vendored schemes, relabelled: an IR
 * that derives is what the row-builder requires, and a synthetic palette built
 * here would be a second thing to keep passing `deriveTheme`'s floors.
 */
describe('slice 6 — a .css is a folder, and the resolver is injected', () => {
  /** The vendored scheme's IR, carrying the name and provider a real read would. */
  function asObsidian(source: string, name: string): ThemeIr {
    return { ...irOf(source), name, author: 'Obsidian theme', source: 'obsidian' }
  }

  /** What the resolver answers with: the entries, in the order they are labelled. */
  function entries(irs: ThemeIr[]): ResolvedObsidianFile {
    const variants: ResolvedObsidianVariant[] = irs.map((ir) => ({ variant: ir.variant, ir }))
    return { ok: true, variants }
  }

  /**
   * A real theme folder: `<scratch>/<name>/theme.css`. The file is written so the
   * folder scan can stat it; the fakes never read its bytes, which is the honest
   * shape of the seam — only `resolve-css.ts` opens the file.
   */
  function themeFolderFile(name: string): string {
    const dir = join(scratch(), name)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, OBSIDIAN_THEME_FILE)
    writeFileSync(path, ':root { /* the resolver is faked in this suite */ }\n')
    return path
  }

  /** The dark entry a fake answers with, named after the folder it is standing in. */
  function darkEntry(name: string): ThemeIr {
    return asObsidian(GRUVBOX_YAML, name)
  }

  it('keys a theme by its folder, because the file is always theme.css', async () => {
    const path = themeFolderFile('Cool Theme')
    const seen: string[] = []
    const batch = await importPaths([path], {
      resolveCss: async (asked) => {
        seen.push(asked)
        return entries([darkEntry('Cool Theme')])
      }
    })

    expect(batch.rejected).toEqual([])
    // The stem is `theme` for every Obsidian theme ever written, so the *folder*
    // is what names it (D7).
    expect(batch.imported).toEqual([
      { id: 'obsidian:Cool Theme', name: 'Cool Theme', provider: 'obsidian', variant: 'dark' }
    ])
    expect(seen).toEqual([path])

    const row = rowOf('obsidian:Cool Theme')
    expect(row.provider).toBe('obsidian')
    expect(row.sourcePath).toBe(path)
    expect(row.author).toBe('Obsidian theme')
    // The row renders the palette the resolver answered with, not a re-derivation.
    expect(row.swatches[0]).toBe(tokensOf(GRUVBOX_YAML).ink['950'])
  })

  it('writes one id per entry, the second being obsidian:<folder>:light', async () => {
    const path = themeFolderFile('Pair')
    const batch = await importPaths([path], {
      resolveCss: async () => entries([darkEntry('Pair'), asObsidian(SOLARIZED_YAML, 'Pair')])
    })

    expect(batch.rejected).toEqual([])
    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'obsidian:Pair',
      'obsidian:Pair:light'
    ])
    expect(batch.imported.map((theme) => theme.variant)).toEqual(['dark', 'light'])
    // Both are rows, and each carries its own palette: the pair is two themes, not
    // one theme with two labels.
    expect(readLibrary().map((theme) => theme.id)).toEqual(['obsidian:Pair', 'obsidian:Pair:light'])
    expect(rowOf('obsidian:Pair').swatches[0]).not.toBe(rowOf('obsidian:Pair:light').swatches[0])
    expect(rowOf('obsidian:Pair:light').sourcePath).toBe(path)
  })

  it('rejects a picked .css that is not a theme folder’s theme.css', async () => {
    // Two ways a stylesheet is not an Obsidian theme, both D7's, and both answered
    // *before* the resolver is asked — nothing about either needs a window.
    const loose = writeScratch('notes.css', ':root { --x: #fff; }\n')
    const asked: string[] = []
    const resolver = async (path: string): Promise<ResolvedObsidianFile> => {
      asked.push(path)
      return entries([darkEntry('Whatever')])
    }

    const looseBatch = await importPaths([loose], { resolveCss: resolver })
    expect(looseBatch.imported).toEqual([])
    expect(looseBatch.rejected).toHaveLength(1)
    expect(looseBatch.rejected[0].path).toBe(loose)
    expect(looseBatch.rejected[0].reason).toContain(
      'an Obsidian theme is a folder containing theme.css'
    )

    // A `theme.css` with no folder at all cannot be named, so it cannot be a
    // theme: `dirname` of a bare file name names no folder.
    const bareBatch = await importPaths([OBSIDIAN_THEME_FILE], { resolveCss: resolver })
    expect(bareBatch.rejected).toHaveLength(1)
    expect(bareBatch.rejected[0].reason).toContain('is not inside a theme folder')

    expect(asked).toEqual([])
  })

  it('finds a theme folder one level into the drop box, and only that', async () => {
    mkdirSync(themeFolder(), { recursive: true })
    copyFileSync(NORD_ITERM, join(themeFolder(), 'nord.itermcolors'))
    // A loose stylesheet beside it: silent, and the case above in the folder scan
    // says why.
    writeFileSync(join(themeFolder(), 'notes.css'), ':root { --x: #fff; }\n')
    // The theme: `<drop>/obsidian-theme/theme.css`.
    const dir = join(themeFolder(), 'obsidian-theme')
    mkdirSync(dir)
    const themeCss = join(dir, OBSIDIAN_THEME_FILE)
    writeFileSync(themeCss, ':root { --x: #fff; }\n')
    // A folder without a theme.css is not a theme either.
    mkdirSync(join(themeFolder(), 'not-a-theme'))

    const seen: string[] = []
    const batch = await scanFolder({
      resolveCss: async (asked) => {
        seen.push(asked)
        return entries([darkEntry('obsidian-theme')])
      }
    })

    expect(batch.rejected).toEqual([])
    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'iterm:nord',
      'obsidian:obsidian-theme'
    ])
    expect(seen).toEqual([themeCss])
    expect(rowOf('obsidian:obsidian-theme').provider).toBe('obsidian')
  })

  it('reports one Obsidian member and imports the rest of the batch, in input order', async () => {
    const good = themeFolderFile('Good')
    const broken = themeFolderFile('Broken')

    const batch = await importPaths([GRUVBOX_YAML, broken, good], {
      // A batch is per file: the resolver's refusal is *this* file's rejection,
      // and it names the path like every other failure does.
      resolveCss: async (asked) =>
        asked === broken
          ? {
              ok: false,
              reason: `${asked}: canvas is unresolved (no usable --background-secondary)`
            }
          : entries([darkEntry('Good')])
    })

    expect(batch.imported.map((theme) => theme.id)).toEqual([
      'base16:gruvbox-dark-hard',
      'obsidian:Good'
    ])
    expect(batch.rejected.map((row) => row.path)).toEqual([broken])
    expect(batch.rejected[0].reason).toContain('--background-secondary')
    // The refused file left no row behind, and the two around it are usable.
    expect(readLibrary().map((theme) => theme.id)).toEqual([
      'base16:gruvbox-dark-hard',
      'obsidian:Good'
    ])
    expect(setTheme('obsidian:Good').ok).toBe(true)
  })

  it('keeps a stale Obsidian row’s stored values instead of re-reading its file', async () => {
    const path = themeFolderFile('Stale')
    await importPaths([path], { resolveCss: async () => entries([darkEntry('Stale')]) })
    const stored = readLibrary()
    expect(stored).toHaveLength(1)

    // An engine-version bump is the state J3 describes — the row's values were
    // derived by older rules. Its source is a stylesheet, whose values only exist
    // inside a live cascade (D1), and this ladder runs inside `resolveId`, on the
    // click's critical path: so the stored values stay and the row is flagged,
    // rather than the click reaching for a hidden window (J3/J4, D6).
    setConfig(
      THEME_LIBRARY_KEY,
      JSON.stringify(stored.map((row) => ({ ...row, engineVersion: 0 })))
    )

    const applied = setTheme('obsidian:Stale')
    if (!applied.ok) throw new Error(`the stored Obsidian row was refused: ${applied.reason}`)
    expect(applied.view.active.id).toBe('obsidian:Stale')
    expect(applied.view.active.sourcePath).toBe(path)
    expect(applied.view.active.engineVersion).toBe(0)
    // "Keep the stored values" means exactly that: the tokens are the ones the
    // import derived, not a fresh derivation from a file nothing can re-read.
    expect(applied.view.active.tokens).toEqual(stored[0].tokens)
    // And the two places the flag surfaces both say so.
    expect(applied.view.stale).toBe(true)
    expect(rowOf('obsidian:Stale').stale).toBe(true)
  })

  it('is a light row when its own palette is light, whatever the file is called', async () => {
    // Non-vacuity for the id rule: a single-entry file is named by its folder even
    // when that entry is light, and no `:light` suffix appears because there is no
    // second entry to tell it apart from.
    const path = themeFolderFile('Sunlit')
    const batch = await importPaths([path], {
      resolveCss: async () => entries([asObsidian(SOLARIZED_YAML, 'Sunlit')])
    })

    expect(batch.imported.map((theme) => theme.id)).toEqual(['obsidian:Sunlit'])
    expect(batch.imported.map((theme) => theme.variant)).toEqual(['light'])
    expect(rowOf('obsidian:Sunlit').variant).toBe('light')
  })
})
