import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { applyTokens } from './lib/theme/css'
import { useThemeStore } from './stores/theme.store'

/**
 * The stored theme, read and applied **before** the first render.
 *
 * React must never paint `:root`'s palette and then swap it — the swap is one or
 * more frames of the wrong theme. One IPC round trip is ~1 ms, and the window's
 * own background (`createWindow()`'s `backgroundColor`) already covers the frame
 * before any of this runs.
 *
 * Failing-safe by design: main is the only writer of these values and it
 * validates them, but a main process that cannot answer must leave `:root`
 * standing and still render the app (`CLAUDE.md` #12) — so every failure is
 * reported, and the render below happens either way. The read is guarded here
 * because it is an IPC round trip; the apply is guarded *inside* `applyTokens`,
 * which reports its own failure as a reason string rather than throwing, so this
 * file and `src/hooks/useTheme.ts` are safe for the same reason rather than by
 * two intentions.
 */
async function bootstrap(): Promise<void> {
  try {
    const view = await window.Musaeum.theme.get()
    // Into the store first: it is the single source of UI truth, and slice 4's
    // picker reads the view from it.
    useThemeStore.getState().setView(view)
    const reason = applyTokens(view.active.tokens)
    if (reason) {
      console.error(`[theme] could not apply the stored theme; :root stands: ${reason}`)
    }
  } catch (err) {
    console.error('[theme] could not read the stored theme; :root stands:', err)
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
