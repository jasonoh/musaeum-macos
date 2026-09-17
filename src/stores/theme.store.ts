import { create } from 'zustand'
import type { ThemeView } from '@shared/theme.types'

/**
 * The active theme, as UI state.
 *
 * The store is the single source of UI truth (`CLAUDE.md`): `src/main.tsx` seeds
 * it from the pre-paint read, `useTheme` keeps it in step with main's
 * `themeChanged` event, and slice 4's picker reads it. Nothing here touches the
 * DOM — `useTheme` owns applying the tokens, so "what is active" and "what is
 * painted" stay one derived thing.
 */
interface ThemeState {
  /** Null only when the pre-paint read failed; `:root`'s palette is then showing. */
  view: ThemeView | null
  setView(view: ThemeView): void
  /**
   * Ask main to switch the active theme. Resolves with the reason on rejection —
   * a theme the user picked that cannot be read is a reportable value, not an
   * exception the caller has to wrap (`CLAUDE.md` #12) — and leaves the current
   * view untouched either way (main writes nothing on a rejection).
   */
  setTheme(id: string): Promise<string | null>
}

export const useThemeStore = create<ThemeState>()((set) => ({
  view: null,
  setView: (view) => set({ view }),

  setTheme: async (id) => {
    try {
      const view = await window.Musaeum.theme.set(id)
      set({ view })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
}))
