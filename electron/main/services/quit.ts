/**
 * Electron's async-shutdown handshake for `before-quit`, extracted so the
 * guard logic is unit-testable without a real Electron app.
 *
 * `before-quit` fires before `will-quit`, and `will-quit` fires before the
 * process actually exits — but a synchronous `before-quit` handler cannot
 * `await` anything: the quit proceeds regardless. To flush reading position
 * to the NAS before the database closes (`teardown` calls `closeDb`), the
 * first call to the returned handler must call `event.preventDefault()`,
 * run `flush`, and then call `quit()` again — which re-fires `before-quit`.
 *
 * The `flushed` guard is what stops that re-entry from looping: on the
 * second call it is already true, so the handler skips straight to
 * `teardown` without calling `preventDefault` or `quit` again, letting the
 * quit complete. Without the guard, `quit()` would re-invoke this same
 * handler, which would `preventDefault` again forever.
 */

export interface QuitFlushDeps {
  /** Bounded by its own timeout upstream — this module does not add one. */
  flush: () => Promise<void>
  /** Synchronous teardown: stop watchers/timers, close the database. */
  teardown: () => void
  quit: () => void
}

export interface PreventableEvent {
  preventDefault(): void
}

export function createBeforeQuitHandler(deps: QuitFlushDeps): (event: PreventableEvent) => void {
  let flushed = false
  return (event) => {
    if (!flushed) {
      event.preventDefault()
      deps
        .flush()
        .catch((err) => console.error('[quit] flush failed:', err))
        .finally(() => {
          flushed = true
          deps.quit()
        })
      return
    }
    deps.teardown()
  }
}
