import { readFileSync } from 'fs'
import type { LoadedTheme } from '@shared/theme.types'
import { deriveTheme } from './derive'
import { base16ToIr, parseBase16 } from './parse/base16'
import { parseItermcolors } from './parse/itermcolors'

/**
 * The theme engine's front door: provider file (or its text) -> one IR -> the
 * derived tokens.
 *
 * Two things this file is careful about:
 *
 * 1. It never throws. A file it cannot read, an extension it does not know, a
 *    palette that cannot meet its contrast floors: all are values
 *    (`CLAUDE.md` #12). The IPC layer turns them into a per-row reason, so
 *    importing five files with one bad member still reports the other four.
 * 2. The pure layer stays free of `fs`. The adapters take text; `loadThemeFile`
 *    is the only edge that touches the disk, which is what makes the whole
 *    derivation unit-testable.
 */

/**
 * Versions the rules in `derive.ts`. A persisted token set carries the version
 * that produced it, so a set written by older rules can be told from one this
 * engine would derive today.
 */
export const THEME_ENGINE_VERSION = 1

/** The file name with its directories stripped — the part a reason may print. */
function baseName(fileName: string): string {
  return fileName.slice(fileName.lastIndexOf('/') + 1)
}

/** The extension of a file name, lowercased. Empty when it has none. */
function extensionOf(fileName: string): string {
  const base = baseName(fileName)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** The file name without its extension — the prototype's `Path(path).stem`. */
function stemOf(fileName: string): string {
  const base = baseName(fileName)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? base : base.slice(0, dot)
}

/**
 * What to call the file's *type* in a reason. The slot it fills names a type, so it
 * must never receive a path: the caller's path is long, it is not a type, and this
 * string surfaces verbatim in slice 4's per-row reason (`Unsupported theme file
 * type: /Users/me/themes/MyPalette` was the old reading of a name with no
 * extension). With no extension to print the file is named by its basename instead
 * — directories stripped, as `extensionOf`/`stemOf` do.
 *
 * A dotfile (`.itermcolors`, no stem) is the one case where the basename *is* a
 * supported extension: printing it here declared unsupported the very extension the
 * sentence lists as supported. The dispatcher gives such a name no extension at all
 * (a leading dot is not one), so the reason says that instead.
 *
 * `type: ` and `type: .` read as bugs in the app rather than facts about the file,
 * which is why an empty name gets a name of its own.
 */
function describeType(fileName: string, extension: string): string {
  if (extension.length > 1) return extension
  const base = baseName(fileName)
  if (base === '') return 'unnamed file'
  if (base.startsWith('.')) return `a dotfile with no usable extension (${base})`
  return base
}

/**
 * Dispatch on the extension: `.yaml`/`.yml` are base16, `.itermcolors` iTerm2.
 *
 * A `.css` gets a sentence of its own rather than the generic type refusal. It is
 * a *supported* provider as of slice 6 — the thing that is wrong is the *reader*,
 * not the file: an Obsidian theme's values only exist inside a live cascade, so
 * it resolves through its folder via the async door (`loadThemeFileAsync`), and
 * this synchronous, pure text reader can never be the one that reads it. Without
 * the sentence a caller holding a stylesheet would read "unsupported theme file
 * type" and conclude the extension is not a provider at all (D6).
 */
export function loadThemeText(fileName: string, text: string): LoadedTheme {
  const extension = extensionOf(fileName)
  if (extension === '.yaml' || extension === '.yml') {
    const parsed = parseBase16(text)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    return { ok: true, ir: base16ToIr(parsed.scheme) }
  }
  if (extension === '.itermcolors') return parseItermcolors(text, stemOf(fileName))
  if (extension === '.css') {
    return {
      ok: false,
      reason: 'Unsupported theme file type: .css — an Obsidian theme resolves through its folder'
    }
  }
  return {
    ok: false,
    reason: `Unsupported theme file type: ${describeType(fileName, extension)} — expected .yaml, .yml or .itermcolors`
  }
}

/** `loadThemeText` with the reading done here — the one file-system edge. */
export function loadThemeFile(path: string): LoadedTheme {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `Could not read ${path}: ${detail}` }
  }
  return loadThemeText(path, text)
}

/**
 * `loadThemeFile` for the one provider that cannot be read synchronously.
 *
 * The synchronous door stays exactly what it was: text in, IR out, and the only
 * disk edge. A `.css` is a different kind of file — its values come out of a
 * running cascade — so it goes through `resolveCss`, which is the Electron
 * resolver in production and a fake in every Obsidian test.
 *
 * **The `await import(...)` is inside the function body on purpose.** A static
 * import of `resolve-css` would pull `electron`'s `BrowserWindow` and `session`
 * into every module that reads a `.yaml`, and `test/mocks/electron.ts` carries a
 * bare `class BrowserWindow {}` and no `session` at all — so the lazy import is
 * what keeps the yaml and iTerm2 suites electron-free (D6). It also means a
 * caller that only ever imports a base16 scheme never builds the resolver's
 * module graph.
 *
 * Never throws: an unreadable file or a stylesheet whose required roles are
 * unresolved is `{ ok: false, reason }`, the same shape the other adapters
 * answer (`CLAUDE.md` #12).
 */
export async function loadThemeFileAsync(
  path: string,
  resolveCss?: (path: string) => Promise<LoadedTheme>
): Promise<LoadedTheme> {
  if (extensionOf(path) !== '.css') return loadThemeFile(path)
  const resolve = resolveCss ?? (await import('./resolve-css')).resolveObsidianTheme
  return resolve(path)
}

export { deriveTheme, parseBase16, base16ToIr, parseItermcolors }
/**
 * The front door re-exports the failure shapes a *caller* can actually be handed:
 * the discriminated pair and their parts. `FloorReason` and `MalformedReason` are
 * what `DeriveFailure` narrows to, so slice 4 can format a per-row reason from
 * `reason.kind` alone and never read `ratio` off a rejection that was never
 * measured. `FloorFailure` — the pre-discriminant `{ role, ratio, floor }` — is
 * deliberately *not* re-exported here: it is not a shape a result can take any
 * more, only the base `FloorReason` extends, and exporting it from the engine is
 * how a caller gets handed back exactly the type the discriminant was added to
 * retire (a cast then restores the un-narrowed `.ratio`). It is still defined in
 * `@shared/theme.types` beside `FloorReason` for anyone who needs the base.
 */
export type {
  DeriveFailure,
  DeriveResult,
  DerivedTokens,
  FloorMetric,
  FloorReason,
  LoadedTheme,
  MalformedReason,
  StatusRamp,
  ThemeAudit,
  ThemeIr
} from '@shared/theme.types'
