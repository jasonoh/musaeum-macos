import type { ThemeView } from '@shared/theme.types'
import { broadcast } from '../services/events'
import { getThemeView, setTheme } from '../services/theme/store'
import { handle } from './handle'

/**
 * The theme IPC surface — thin wrappers, the work is in `services/theme/store.ts`.
 *
 * `theme:set` is the one handler here that decides something, and it decides it
 * deliberately: the service returns a rejection as a *value* (`{ ok: false,
 * reason }` — `CLAUDE.md` #12 keeps a theme that cannot be read non-fatal), and
 * `src/types/api.types.ts` freezes the renderer's `set` as
 * **reject-on-unreadable-theme**. So an unresolvable id becomes a rejection
 * carrying the reason verbatim, and the picker (slice 4) catches it to print a
 * per-row reason. The other arm is never a rejection: a write that cannot happen
 * throws out of the transaction on its own, which `handle()` reports as a
 * failure — the stored pair is untouched either way.
 */
export function registerThemeHandlers(): void {
  handle('theme:get', () => getThemeView())

  handle('theme:set', (id: string): ThemeView => {
    const result = setTheme(id)
    if (!result.ok) throw new Error(result.reason)
    broadcast('themeChanged', result.view)
    return result.view
  })
}
