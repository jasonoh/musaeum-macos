import { BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/api.types'

type ChannelKey = keyof typeof EVENT_CHANNELS

/** Main's own consumer of the stream `broadcast` pushes to the renderer. */
type Listener = (event: ChannelKey, payload?: unknown) => void

let mainWindow: BrowserWindow | null = null
const listeners = new Set<Listener>()

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

/**
 * Subscribe to the same events `broadcast` sends to the renderer.
 *
 * The window's background and the platform's own scheme have to follow the theme
 * on the *same* signal the renderer follows, or the native chrome can disagree
 * with the body it frames. So they ride this broadcast rather than a second
 * channel or a line in `ipc/theme.ts`'s handler: a handler is a thin wrapper
 * (`CLAUDE.md` #8) and a second channel is a second source of truth for "what is
 * active" — D6, `docs/superpowers/plans/2026-09-19-theming-slice5.md`. One event,
 * one path, two consumers that cannot drift.
 *
 * Returns its own unsubscribe. The registry is process-lifetime by design (one
 * subscriber, `electron/main/index.ts`, which never wants to stop listening);
 * the returned function exists so a caller that does not want that — a test, or
 * a future window-scoped consumer — can take its listener back.
 *
 * A listener that throws is **logged and skipped**, never propagated
 * (`CLAUDE.md` #12): one bad listener must not stop the other listeners and must
 * not stop the renderer's push, which is this module's original job.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Push an event to the renderer, then to main's own listeners. Safe to call
 * before the window exists, and inert when nothing is subscribed.
 */
export function broadcast(event: ChannelKey, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(EVENT_CHANNELS[event], payload)
  }
  // A copy, so a listener that subscribes or unsubscribes itself inside its own
  // callback cannot change what this dispatch delivers to.
  for (const listener of [...listeners]) {
    try {
      listener(event, payload)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[events] a listener for "${event}" threw: ${detail}`)
    }
  }
}
