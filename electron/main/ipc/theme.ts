import { dialog } from 'electron'
import type { ThemeImportResult, ThemeView } from '@shared/theme.types'
import { broadcast } from '../services/events'
import { importPaths, scanFolder, withThemeView } from '../services/theme/importer'
import { getThemeView, openThemeFolder, setTheme, themeFolder } from '../services/theme/store'
import { handle } from './handle'

/**
 * What the picker offers, for the dialog's filter popup. Electron takes the
 * extensions without their dots; the first entry is the default selection, so it
 * is the one that shows every file the importer can read.
 *
 * `css` is the fourth extension site A45 names, and it is here rather than folded
 * into an existing entry because the filter list is what tells the user what the
 * app reads: an Obsidian theme is picked as a `theme.css` inside its own folder
 * (the dialog cannot select a directory in `openFile` mode), so the entry names
 * both the extension and the file the folder is expected to hold.
 */
const THEME_FILTERS = [
  { name: 'Theme files', extensions: ['yaml', 'yml', 'itermcolors', 'css'] },
  { name: 'base16 schemes', extensions: ['yaml', 'yml'] },
  { name: 'iTerm2 colour schemes', extensions: ['itermcolors'] },
  { name: 'Obsidian themes', extensions: ['css'] }
]

/**
 * The theme IPC surface — thin wrappers, the work is in `services/theme/`.
 *
 * `theme:set` is the one handler here that decides something, and it decides it
 * deliberately: the service returns a rejection as a *value* (`{ ok: false,
 * reason }` — `CLAUDE.md` #12 keeps a theme that cannot be read non-fatal), and
 * `src/types/api.types.ts` freezes the renderer's `set` as
 * **reject-on-unreadable-theme**. So an unresolvable id becomes a rejection
 * carrying the reason verbatim, and the picker catches it to print a per-row
 * reason. The other arm is never a rejection: a write that cannot happen throws
 * out of the transaction on its own, which `handle()` reports as a failure — the
 * stored pair is untouched either way.
 *
 * The four import handlers answer with the **whole view** rather than only the
 * files they touched (D10): the rows the user is looking at and the files that
 * were just imported are then one answer instead of two that can disagree, and
 * the renderer needs one round trip, not two. None of them broadcasts — an import
 * never activates a theme (D5), and this is the call that already has the answer.
 * The one thing they return in full is a *partial* result: a malformed member is
 * a row, never a failed call (AC4.2).
 *
 * That composition is `withThemeView` in the service rather than an object literal
 * written here, and the reason is order: `{ view: getThemeView(), ...batch }`
 * evaluates the view *first*, so the returned list predated the import. The
 * handler is now one line and the ordering has a decider (`importer.test.ts`).
 */
export function registerThemeHandlers(): void {
  handle('theme:get', () => getThemeView())

  handle('theme:set', (id: string): ThemeView => {
    const result = setTheme(id)
    if (!result.ok) throw new Error(result.reason)
    broadcast('themeChanged', result.view)
    return result.view
  })

  // The three import handlers **await** the service: slice 6 made
  // `importPaths`/`scanFolder` async because a `.css` resolves through the
  // Electron resolver window, and `handle()` awaits promises either way — so the
  // only thing that changed here is the one `await`. The handlers stay thin: the
  // composition (and its ordering) is still `withThemeView`'s.
  handle('theme:importPaths', async (paths: string[]): Promise<ThemeImportResult> =>
    withThemeView(await importPaths(paths))
  )

  handle('theme:importFromDialog', async (): Promise<ThemeImportResult> => {
    const result = await dialog.showOpenDialog({
      title: 'Import Theme',
      // The drop-box is where a theme the user has not picked yet usually comes
      // from, and it works before the folder exists — the dialog does not need it
      // to exist to open there.
      defaultPath: themeFolder(),
      properties: ['openFile', 'multiSelections'],
      filters: THEME_FILTERS
    })
    // A cancelled dialog is not a failure: nothing was imported, and the view is
    // answered from storage so the caller gets the same shape either way.
    if (result.canceled || !result.filePaths.length) {
      return withThemeView({ imported: [], rejected: [] })
    }
    return withThemeView(await importPaths(result.filePaths))
  })

  handle('theme:scanFolder', async (): Promise<ThemeImportResult> =>
    withThemeView(await scanFolder())
  )

  handle('theme:openFolder', () => openThemeFolder())
}
