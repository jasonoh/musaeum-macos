import { create } from 'zustand'
import type { ThemeImportResult, ThemeView } from '@shared/theme.types'

/**
 * The active theme, as UI state.
 *
 * The store is the single source of UI truth (`CLAUDE.md`): `src/main.tsx` seeds
 * it from the pre-paint read, `useTheme` keeps it in step with main's
 * `themeChanged` event, and slice 4's picker reads it. Nothing here touches the
 * DOM — `useTheme` owns applying the tokens, so "what is active" and "what is
 * painted" stay one derived thing.
 *
 * The picker's actions keep `setTheme`'s shape: a failure is a **reason string**,
 * never a throw (`CLAUDE.md` #12), and it lands where the UI can print it —
 * `themeError` for the row that was clicked, `importError` for a call that has no
 * row to print it in. The reason is *also* returned, so a caller can chain on it
 * without reading the state back.
 *
 * Every answer that carries a `ThemeView` **replaces** the view rather than
 * patching it: main returns the whole view, so the list can never disagree with
 * the import that has just run (D10). And nothing here activates a theme —
 * importing adds rows, clicking one applies it (D5).
 */
interface ThemeState {
  /** Null only when the pre-paint read failed; `:root`'s palette is then showing. */
  view: ThemeView | null
  /** The row whose click was refused, with the engine's reason for it. */
  themeError: { id: string; reason: string } | null
  /**
   * Main's answer to the last import that ran, rejections included. The whole
   * result is kept, not just the count: four imported and one rejected is the
   * normal case rather than an error, and the section lists each reason (AC4.2).
   */
  lastImport: ThemeImportResult | null
  /** A call that failed outright: the dialog, the shell hand-off, the scan. */
  importError: string | null
  /**
   * An import, scan or reveal in flight — the section's busy state. A UI flag,
   * not a lock: a drop during an import can put two calls in the air, and the
   * one that settles last is the one whose report is showing either way.
   */
  busy: boolean
  setView(view: ThemeView): void
  /**
   * Ask main to switch the active theme. Resolves with the reason on rejection —
   * a theme the user picked that cannot be read is a reportable value, not an
   * exception the caller has to wrap (`CLAUDE.md` #12) — and leaves the current
   * view untouched either way (main writes nothing on a rejection).
   */
  setTheme(id: string): Promise<string | null>
  /** Import provider files by path: dropped ones, or one the user chose. */
  importPaths(paths: string[]): Promise<string | null>
  /** The native multi-select picker. A cancelled dialog imports nothing. */
  importFromDialog(): Promise<string | null>
  /** Re-scan the drop-box directory, so files put there by hand show up (AC4.3). */
  syncFolder(): Promise<string | null>
  /** Reveal the drop-box directory in Finder; main creates it when absent (D8). */
  revealFolder(): Promise<string | null>
}

/** A thrown anything, as the string a row or a report line can print. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useThemeStore = create<ThemeState>()((set) => {
  /**
   * One round trip to main, with the busy flag around it and no throw out of it.
   *
   * The three import-shaped actions differ only in which IPC member they open, so
   * they share this: a per-action copy is how one of them ends up forgetting the
   * `finally` and leaving the section spinning — the same reasoning that keeps the
   * apply guard inside `applyTokens` rather than at each call site.
   */
  const runImport = async (call: () => Promise<ThemeImportResult>): Promise<string | null> => {
    set({ busy: true })
    try {
      const result = await call()
      // `themeError` is cleared too: a refused row's reason belongs to the list
      // that was on screen when it was refused, and an import has just replaced
      // that list.
      set({ view: result.view, lastImport: result, importError: null, themeError: null })
      return null
    } catch (err) {
      const reason = reasonOf(err)
      // `lastImport` is deliberately left standing: a call that never reached the
      // importer says nothing about the import before it, whose answer is still
      // the last one the user was shown.
      set({ importError: reason })
      return reason
    } finally {
      set({ busy: false })
    }
  }

  return {
    view: null,
    themeError: null,
    lastImport: null,
    importError: null,
    busy: false,

    setView: (view) => set({ view }),

    setTheme: async (id) => {
      try {
        const view = await window.Musaeum.theme.set(id)
        // Cleared on success rather than on click: a refusal stays on screen until
        // the theme it is about is actually replaced.
        set({ view, themeError: null })
        return null
      } catch (err) {
        const reason = reasonOf(err)
        set({ themeError: { id, reason } })
        return reason
      }
    },

    importPaths: (paths) => runImport(() => window.Musaeum.theme.importPaths(paths)),

    importFromDialog: () => runImport(() => window.Musaeum.theme.importFromDialog()),

    syncFolder: () => runImport(() => window.Musaeum.theme.scanFolder()),

    revealFolder: async () => {
      // Busy like the imports are: this is a shell hand-off that may have to
      // create the directory first (D8), and the control must not look idle
      // while the Finder window is still being asked for.
      set({ busy: true })
      try {
        await window.Musaeum.theme.openFolder()
        set({ importError: null })
        return null
      } catch (err) {
        const reason = reasonOf(err)
        set({ importError: reason })
        return reason
      } finally {
        set({ busy: false })
      }
    }
  }
})
