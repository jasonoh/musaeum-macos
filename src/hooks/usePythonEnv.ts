import { useEffect } from 'react'
import { useUIStore } from '@/stores/ui.store'

/**
 * Track the one-time Python environment bootstrap. Mount once at app root.
 *
 * The `ready` state is dropped rather than stored: the bootstrap only runs on
 * a first launch, and leaving "Metadata engine ready" pinned to the status bar
 * would outlive the thing it describes. A failure is kept, because the reason
 * hydration is unavailable stays true until it is fixed.
 *
 * Subscribing is not enough on its own. `ensurePythonEnv` runs immediately
 * after `createWindow()`, so on a machine with no usable interpreter the
 * `failed` event is broadcast *before* this effect exists and is lost — the
 * app then looks healthy while every metadata feature silently does nothing.
 * So the current state is also fetched once on mount. The subscription is set
 * up first, and the fetch defers to any event that has since arrived: the
 * reply describes an older moment than a live event does.
 */
export function usePythonEnv(): void {
  useEffect(() => {
    let heardEvent = false
    let cancelled = false

    const unsubscribe = window.Musaeum.on.pythonEnvProgress((progress) => {
      heardEvent = true
      useUIStore.getState().setPythonEnv(progress.stage === 'ready' ? null : progress)
    })

    void window.Musaeum.settings
      .getPythonEnv()
      .then((state) => {
        if (cancelled || heardEvent || !state) return
        useUIStore.getState().setPythonEnv(state)
      })
      .catch(() => {
        // Nothing to show: a failure to ask is not itself a bootstrap failure
      })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
}
