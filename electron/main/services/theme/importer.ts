import { readdirSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import type {
  ImportedTheme,
  RejectedTheme,
  StoredTheme,
  ThemeImportResult,
  ThemeProvider
} from '@shared/theme.types'
import { loadThemeFile } from './index'
import { OBSIDIAN_THEME_FILE, themeFolderName, type ResolvedObsidianFile } from './parse/obsidian'
import { getThemeView, storedRecordOf, themeFolder, upsertLibrary } from './store'

/**
 * The front door for provider files: a picked path, a path dropped on the
 * settings section, and a folder scan all end in the same
 * read → parse → derive → validate → upsert.
 *
 * Four things this file is careful about:
 *
 * 1. **A batch never aborts on a member.** Each file is independent, and a
 *    failure is a `{ path, reason }` row carrying the engine's own reason string
 *    verbatim (D6, AC4.2): a batch of five with one malformed member reports four
 *    imported and one rejected, and nothing is partially written for the failure.
 * 2. **Importing never activates.** These functions add and update rows; the
 *    active theme changes only when the user clicks one (D5). Importing three
 *    themes leaves the app on the theme it was on.
 * 3. **The drop-box is read-only.** `scanFolder` reads a directory and derives
 *    from what is in it; nothing here creates, copies, renames or normalizes a
 *    file (AC4.3). The app stores derived *values*, which is what lets a theme be
 *    applied after its source has moved away.
 * 4. **The one provider that needs Electron is injected, never imported.** A
 *    `.css` resolves through the resolver window, which is async and
 *    Electron-bound, so the resolver is a parameter (`ImportOptions.resolveCss`)
 *    with a **lazy** dynamic import as its default. Every Obsidian case can then
 *    pass a fake and decide the pipeline — id, rows, rejection list, batch
 *    independence — without Electron, and the yaml/iTerm2 cases never build the
 *    resolver's module graph at all (D6).
 *
 * The dialog and `shell.openPath` belong to the IPC layer: nothing here imports
 * `electron`, so the whole pipeline is exercisable against real files.
 */

/** What a batch reports. `ThemeImportResult` adds the view at the IPC layer. */
export interface ThemeImportBatch {
  imported: ImportedTheme[]
  rejected: RejectedTheme[]
}

/**
 * The one injection point: what reads a `.css`.
 *
 * **The shape is the *file's entries*, not one `LoadedTheme`.** A `.css` can
 * legally resolve to two palettes (D5 — Tokyo Night and Things declare both
 * classes; Dracula + LYT's light class resolves to a dark palette and so yields
 * one), and the id rule (`obsidian:<folder>` and `obsidian:<folder>:light`) is
 * about the entries, not about a single theme. A seam that could only answer one
 * `LoadedTheme` could not carry the light entry the second id names.
 *
 * The real implementation is `resolve-css.ts`'s `resolveObsidianFile`; the type
 * lives in the pure adapter so this file needs no import from a module that
 * touches `electron`.
 */
export interface ImportOptions {
  resolveCss?: (path: string) => Promise<ResolvedObsidianFile>
}

/**
 * A batch, plus the view it produced.
 *
 * **This is the only place those two are put together, and the order is the whole
 * reason it exists.** The obvious spelling at a call site —
 * `{ view: getThemeView(), ...importPaths(paths) }` — reads the view *before* the
 * import runs, because an object literal's properties evaluate left to right. The
 * row the user had just imported was then missing from the list they were looking
 * at, and pressing Refresh did not help: the stale view *replaced* the good one,
 * so a newly dropped theme stayed invisible until some later interaction happened
 * to re-read it. Nothing caught it — the handler layer has no harness
 * (`ipcMain.handle` is a no-op in the Electron mock), and every live check read the
 * view back with a second `theme.get()`, which of course agreed.
 *
 * So the composition lives in the service, where `importer.test.ts` can decide it,
 * and each IPC handler is one line.
 */
export function withThemeView(batch: ThemeImportBatch): ThemeImportResult {
  return { view: getThemeView(), ...batch }
}

/**
 * The id namespace each provider's imports live in — uniform with the built-ins'
 * `builtin:` prefix, so "an id names a file" stays one rule (D1).
 *
 * The **stem** rather than a `slug:` key is deliberate: the vendored corpus
 * carries a slug in 1 of 13 files, so a slug-keyed id would be a branch that is
 * dead for nearly every file the owner has — and it would split one scheme into
 * two ids the moment the same palette arrives with a slug and without one.
 * Stem-keyed is also what makes D2 structural rather than a check: every
 * imported id starts `base16:`/`iterm:` and every built-in starts `builtin:`, so
 * a file named `musaeum.yaml` cannot replace the default.
 *
 * The one exception is Obsidian, and it is D7's: a theme is identified by the
 * **folder** holding its `theme.css`, because the file is always named
 * `theme.css` — a stem-keyed id would call every Obsidian theme `obsidian:theme`.
 *
 * `native` is here only so the map is total over `ThemeProvider`: no adapter
 * reports it (the built-in default does, and the default is never a file).
 */
const ID_PREFIX: Record<ThemeProvider, string> = {
  base16: 'base16',
  itermcolors: 'iterm',
  obsidian: 'obsidian',
  native: 'native'
}

/**
 * The extensions a folder scan accepts, matching the adapters' dispatch. `.css`
 * is one of them as of slice 6; *where* a stylesheet may sit to be a theme is
 * D7's separate rule, applied below.
 *
 * A file whose extension is in this set but which the app cannot read is
 * reported when the user put it there deliberately — that is what the picked and
 * dropped paths are for. A folder listing is different: it must not fill with
 * reasons about files that are not themes (D7/A35), which is why the loose
 * stylesheet below is skipped rather than reported.
 */
const SCANNABLE_EXTENSIONS = new Set(['.yaml', '.yml', '.itermcolors', '.css'])

/** `…/schemes/gruvbox-dark.yaml` → `gruvbox-dark` — the engine's own stem rule. */
function stemOf(path: string): string {
  const name = basename(path)
  const extension = extname(name)
  return extension === '' ? name : name.slice(0, -extension.length)
}

/** Whether an entry is a readable file — a directory named `x.yaml` is not one. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether an entry is a directory — the one level a theme folder may sit at. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * What a `.css` is, or the reason it is not an Obsidian theme.
 *
 * Two rules, both D7: the file must be named `theme.css` (that name *is* the
 * format — a dropped `notes.css` is a scratch stylesheet), and it must sit in a
 * folder, because the folder is what names the theme. The folder comes back with
 * the success arm rather than being derived a second time at the one call site —
 * it is the id's other half, and two derivations of it are two things that can
 * disagree.
 */
function cssThemeFolder(
  path: string
): { ok: true; folder: string } | { ok: false; reason: string } {
  if (basename(path).toLowerCase() !== OBSIDIAN_THEME_FILE) {
    return {
      ok: false,
      reason: `${basename(path)} is not an Obsidian theme — an Obsidian theme is a folder containing ${OBSIDIAN_THEME_FILE}`
    }
  }
  const folder = themeFolderName(path)
  if (folder === null) {
    return {
      ok: false,
      reason: `${path} is not inside a theme folder — an Obsidian theme is a folder containing ${OBSIDIAN_THEME_FILE}`
    }
  }
  return { ok: true, folder }
}

/** The resolver, injected or lazily imported. Never a static import (`electron`). */
async function resolveCssFor(path: string, options?: ImportOptions): Promise<ResolvedObsidianFile> {
  if (options?.resolveCss !== undefined) return options.resolveCss(path)
  const { resolveObsidianFile } = await import('./resolve-css')
  return resolveObsidianFile(path)
}

/**
 * One `.css` → the records its entries become, or the reason it becomes none.
 *
 * The id and the display name both come from the **parent folder** (D7):
 * `<folder>/theme.css` is `obsidian:<folder>`, and a file that resolves to two
 * entries gives the second one `obsidian:<folder>:light` — the suffix is what
 * the two-row case needs, and the bare id stays the common one (D5's note on the
 * spec's `theme_id` row).
 *
 * Every entry is built before any is written, and a failure on one rejects the
 * file: the importer's report is per path, so the alternative would be a row
 * that says "imported" about half a theme. Nothing is partial in storage either
 * — the upsert for this file is one transaction after the whole build.
 */
async function recordsForCss(
  path: string,
  options?: ImportOptions
): Promise<{ ok: true; themes: StoredTheme[] } | { ok: false; reason: string }> {
  const theme = cssThemeFolder(path)
  if (!theme.ok) return { ok: false, reason: theme.reason }
  const folder = theme.folder

  const resolved = await resolveCssFor(path, options)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }

  const themes: StoredTheme[] = []
  for (const [index, entry] of resolved.variants.entries()) {
    // The second entry is the light one D5 describes (it is kept only when its
    // variant differs from the first's), so its id is the annex's
    // `obsidian:<folder>:light` — spelled from the entry's own variant so the id
    // cannot lie if a file ever resolved the two the other way round.
    const id =
      index === 0
        ? `${ID_PREFIX.obsidian}:${folder}`
        : `${ID_PREFIX.obsidian}:${folder}:${entry.variant}`
    const built = storedRecordOf(entry.ir, id, path)
    // A derivation failure is *this file's* rejection, the same value the
    // stem-keyed path returns for one: the report is per path, so the alternative
    // would be a row that says "imported" about half a theme.
    if (!built.ok) return { ok: false, reason: built.reason }
    themes.push(built.theme)
  }
  return { ok: true, themes }
}

/**
 * One file → the records the library stores, or the reason it cannot be one.
 *
 * The id's namespace comes from the loaded IR's own `source` rather than from the
 * file name: the extension decides which adapter reads the file, so the two agree
 * by construction today, and reading the provider out of the *parsed* file is
 * what keeps the id honest if a later adapter ever sniffs content instead.
 */
async function recordsForPath(
  path: string,
  options?: ImportOptions
): Promise<{ ok: true; themes: StoredTheme[] } | { ok: false; reason: string }> {
  if (extname(path).toLowerCase() === '.css') return recordsForCss(path, options)
  const loaded = loadThemeFile(path)
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  const built = storedRecordOf(loaded.ir, `${ID_PREFIX[loaded.ir.source]}:${stemOf(path)}`, path)
  if (!built.ok) return { ok: false, reason: built.reason }
  return { ok: true, themes: [built.theme] }
}

/**
 * Import provider files by path.
 *
 * Each path is independent (see the header), and the arrays follow the **input
 * order**, so a caller can line a rejection up with the file it names.
 *
 * **Async because one provider is.** A `.css` needs the resolver window; a
 * `.yaml` is still read synchronously inside — the `async` is the seam's shape,
 * not a change to how a base16 scheme is parsed.
 */
export async function importPaths(
  paths: string[],
  options?: ImportOptions
): Promise<ThemeImportBatch> {
  const imported: ImportedTheme[] = []
  const rejected: RejectedTheme[] = []

  // The renderer is untrusted input, even though both of this app's own callers
  // filter first. A non-array throws out of the loop below, and a member that is
  // not a string would become a rejection whose `path` is not a string — which the
  // picker then `basename()`s and uses as a React key, throwing during render
  // instead of reporting the file that failed.
  if (!Array.isArray(paths)) return { imported, rejected }

  for (const candidate of paths) {
    const path = typeof candidate === 'string' ? candidate : String(candidate)
    try {
      const built = await recordsForPath(path, options)
      if (!built.ok) {
        rejected.push({ path, reason: built.reason })
        continue
      }
      upsertLibrary(built.themes)
      for (const theme of built.themes) {
        imported.push({
          id: theme.id,
          name: theme.name,
          provider: theme.provider,
          variant: theme.variant
        })
      }
    } catch (err) {
      // A write that cannot happen is *this file's* rejection, not the batch's
      // end: the files around it are already imported and stay imported, and the
      // failure the user needs to see is the one naming a path.
      const detail = err instanceof Error ? err.message : String(err)
      rejected.push({ path, reason: detail })
    }
  }
  return { imported, rejected }
}

/**
 * Import everything the drop-box directory offers.
 *
 * Read-only and extension-scoped (D7): `readdirSync`, one level deep. A
 * supported provider file at the drop box's own level is a candidate; so is a
 * **folder** holding a `theme.css`, which is the only place a stylesheet is a
 * theme — the folder names it, and a loose `.css` beside the provider files is
 * somebody's scratch stylesheet rather than an Obsidian theme, so it is ignored
 * *silently* (A35: a folder listing is not a list of complaints). Anything else
 * — a directory without a `theme.css`, `.DS_Store`, `README.md` — is skipped the
 * same way.
 *
 * A supported file that fails to parse **is** reported: that one the user put
 * there for this purpose.
 *
 * A missing folder is an empty scan rather than an error — it is the normal
 * first-run state, and nothing on the read path creates it (only the *Reveal in
 * Finder* control does, D8).
 */
export async function scanFolder(options?: ImportOptions): Promise<ThemeImportBatch> {
  const folder = themeFolder()
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return { imported: [], rejected: [] }
  }

  const paths: string[] = []
  for (const name of names.sort()) {
    const full = join(folder, name)
    // `statSync` rather than a dirent's own type: it follows a symlink (a
    // linked-in theme is the user's own file, and the read would have followed it
    // anyway) and it is the same check on every filesystem. A name that cannot be
    // stat'ed is not a file this scan can read, so it is skipped like the rest.
    if (isFile(full)) {
      const extension = extname(name).toLowerCase()
      if (!SCANNABLE_EXTENSIONS.has(extension)) continue
      // A stylesheet is only a theme inside a folder of its own: at this level
      // the "folder" would be the drop box itself, which names no theme.
      if (extension === '.css') continue
      paths.push(full)
      continue
    }
    if (!isDirectory(full)) continue
    // `<name>/theme.css` is a candidate by construction: the file is named for
    // the format and its folder is the subdirectory, so D7's two rules hold
    // without a second check.
    const themeCss = join(full, OBSIDIAN_THEME_FILE)
    if (isFile(themeCss)) paths.push(themeCss)
  }
  // Sorted, so the order of the reported rows is stable from one scan to the
  // next — a folder listing has no order of its own.
  paths.sort()

  return importPaths(paths, options)
}
