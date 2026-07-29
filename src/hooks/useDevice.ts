import { useEffect } from 'react'
import { useDeviceStore } from '@/stores/device.store'

/** Wire device + transfer events into the store. Mount once at app root. */
export function useDevice(): void {
  const refresh = useDeviceStore((s) => s.refresh)
  const addDevice = useDeviceStore((s) => s.addDevice)
  const removeDevice = useDeviceStore((s) => s.removeDevice)
  const upsertTransfer = useDeviceStore((s) => s.upsertTransfer)
  const removeTransfer = useDeviceStore((s) => s.removeTransfer)
  const refreshDeviceContents = useDeviceStore((s) => s.refreshDeviceContents)

  useEffect(() => {
    void refresh()
    const unsubs = [
      window.Musaeum.on.deviceConnected(addDevice),
      window.Musaeum.on.deviceDisconnected(removeDevice),
      window.Musaeum.on.transferProgress((job) => {
        upsertTransfer(job)
        if (job.status === 'done') {
          setTimeout(() => removeTransfer(job.jobId), 5_000)
        }
      }),
      window.Musaeum.on.deviceContentsChanged((deviceId) => {
        void refreshDeviceContents(deviceId)
      }),
      // Presence depends on the book set too — recompute when the library
      // settles (e.g. the slow on-connect catalog sync at cold start), not
      // just when device contents change.
      window.Musaeum.on.libraryChanged(() => {
        for (const d of useDeviceStore.getState().devices) void refreshDeviceContents(d.id)
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [refresh, addDevice, removeDevice, upsertTransfer, removeTransfer, refreshDeviceContents])
}
