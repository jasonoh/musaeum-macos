import { useEffect } from 'react'
import { useDeviceStore } from '@/stores/device.store'

/** Wire device + transfer events into the store. Mount once at app root. */
export function useDevice(): void {
  const refresh = useDeviceStore((s) => s.refresh)
  const addDevice = useDeviceStore((s) => s.addDevice)
  const updateDevice = useDeviceStore((s) => s.updateDevice)
  const removeDevice = useDeviceStore((s) => s.removeDevice)
  const upsertTransfer = useDeviceStore((s) => s.upsertTransfer)
  const removeTransfer = useDeviceStore((s) => s.removeTransfer)
  const refreshDeviceContents = useDeviceStore((s) => s.refreshDeviceContents)

  useEffect(() => {
    void refresh()
    const unsubs = [
      window.Musaeum.on.deviceConnected(addDevice),
      // The row's free space moves as books are sent; the device is the same
      // one, so this restates it rather than re-asking for its contents
      window.Musaeum.on.deviceChanged(updateDevice),
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
  }, [
    refresh,
    addDevice,
    updateDevice,
    removeDevice,
    upsertTransfer,
    removeTransfer,
    refreshDeviceContents
  ])
}
