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
import { getThemeView, storedRecordOf, themeFolder, upsertLibrary } from './store'

/**
 * The front door for provider files: a picked path, a path dropped on the
 * settings section, and a folder scan all end in the same
 * read → parse → derive → validate → upsert.
 *
 * Three things this file is careful about:
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
 * The extensions a folder scan accepts, matching `loadThemeText`'s dispatch.
 * `.css` is deliberately absent: Obsidian is slice 6, and a folder listing must
 * not fill with reasons about files the app cannot read yet (D7).
 */
const SCANNABLE_EXTENSIONS = new Set(['.yaml', '.yml', '.itermcolors'])

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

/**
 * One file → the record the library stores, or the reason it cannot be one.
 *
 * The id's namespace comes from the loaded IR's own `source` rather than from the
 * file name: the extension decides which adapter reads the file, so the two agree
 * by construction today, and reading the provider out of the *parsed* file is
 * what keeps the id honest if a later adapter ever sniffs content instead.
 */
function recordForPath(
  path: string
): { ok: true; theme: StoredTheme } | { ok: false; reason: string } {
  const loaded = loadThemeFile(path)
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  return storedRecordOf(loaded.ir, `${ID_PREFIX[loaded.ir.source]}:${stemOf(path)}`, path)
}

/**
 * Import provider files by path.
 *
 * Each path is independent (see the header), and the arrays follow the **input
 * order**, so a caller can line a rejection up with the file it names.
 */
export function importPaths(paths: string[]): ThemeImportBatch {
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
      const built = recordForPath(path)
      if (!built.ok) {
        rejected.push({ path, reason: built.reason })
        continue
      }
      upsertLibrary([built.theme])
      imported.push({
        id: built.theme.id,
        name: built.theme.name,
        provider: built.theme.provider,
        variant: built.theme.variant
      })
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
 * Read-only and extension-scoped (D7): `readdirSync`, non-recursive, entries that
 * are files whose extension is `.yaml`, `.yml` or `.itermcolors`. Anything else —
 * a directory, `.DS_Store`, `README.md`, a `.css` theme — is ignored *silently*,
 * because a listing full of reasons about files the app cannot read is noise. A
 * supported file that fails to parse **is** reported: that one the user put
 * there for this purpose.
 *
 * A missing folder is an empty scan rather than an error — it is the normal
 * first-run state, and nothing on the read path creates it (only the *Reveal in
 * Finder* control does, D8).
 */
export function scanFolder(): ThemeImportBatch {
  const folder = themeFolder()
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return { imported: [], rejected: [] }
  }

  const paths = names
    .filter((name) => SCANNABLE_EXTENSIONS.has(extname(name).toLowerCase()))
    // `statSync` rather than a dirent's own type: it follows a symlink (a
    // linked-in theme is the user's own file, and the read would have followed it
    // anyway) and it is the same check on every filesystem. A name that cannot be
    // stat'ed is not a file this scan can read, so it is skipped like the rest.
    .filter((name) => isFile(join(folder, name)))
    // Sorted, so the order of the reported rows is stable from one scan to the
    // next — a folder listing has no order of its own.
    .sort()
    .map((name) => join(folder, name))

  return importPaths(paths)
}
