import { useEffect } from 'react'
import { useUIStore } from '@/stores/ui.store'

/**
 * Track the one-time Python environment bootstrap. Mount once at app root.
 *
 * The `ready` state is dropped rather than stored: the bootstrap only runs on
 * a first launch, and leaving "Metadata engine ready" pinned to the status bar
 * would outlive the thing it describes. A failure is kept, because the reason
 * hydration is unavailable stays true until it is fixed.
 */
export function usePythonEnv(): void {
  useEffect(
    () =>
      window.Musaeum.on.pythonEnvProgress((progress) => {
        useUIStore.getState().setPythonEnv(progress.stage === 'ready' ? null : progress)
      }),
    []
  )
}
