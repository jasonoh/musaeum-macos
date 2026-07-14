import { useEffect } from 'react'
import { useNASStore } from '@/stores/nas.store'

/** Wire NAS status into the store. Mount once at app root. */
export function useNASStatus(): void {
  const refresh = useNASStore((s) => s.refresh)
  const setStatus = useNASStore((s) => s.setStatus)

  useEffect(() => {
    void refresh()
    return window.Musaeum.on.nasStatusChanged(setStatus)
  }, [refresh, setStatus])
}
