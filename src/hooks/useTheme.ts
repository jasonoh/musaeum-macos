import { useEffect } from 'react'
import { applyTokens } from '@/lib/theme/css'
import { useThemeStore } from '@/stores/theme.store'

/**
 * Wire the theme into the store and onto the document. Mount once at app root.
 *
 * The *boot* apply is deliberately not here: it happens in `src/main.tsx` before
 * the first render, because a mount effect runs after React has painted and that
 * is one or more frames of the wrong palette (AC3.5). This hook owns everything
 * after the first frame — a theme changed by the picker, or a re-derive main did
 * on its own.
 *
 * The apply is guarded *inside* `applyTokens`, not by a `try`/`catch` here: a
 * throw out of an effect propagates into React and unmounts the tree, and a guard
 * that lives at the call site is one this file can lose again the next time it is
 * edited (it did — `src/main.tsx` caught, this effect did not). The failure comes
 * back as a reason string and is reported, because `CLAUDE.md` #12 keeps a theme
 * that cannot be applied on the palette already showing.
 */
export function useTheme(): void {
  const setView = useThemeStore((s) => s.setView)
  const tokens = useThemeStore((s) => s.view?.active.tokens)

  // Subscribed once; the unsubscribe is the effect's cleanup, so a remount
  // cannot leave a second listener behind.
  useEffect(() => window.Musaeum.on.themeChanged(setView), [setView])

  useEffect(() => {
    if (!tokens) return
    const reason = applyTokens(tokens)
    if (reason) {
      console.warn(`[theme] could not apply the theme; the previous palette stands: ${reason}`)
    }
  }, [tokens])
}
