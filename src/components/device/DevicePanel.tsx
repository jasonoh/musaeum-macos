import { useDeviceStore } from '@/stores/device.store'
import { useLibraryStore } from '@/stores/library.store'
import { DeviceIcon } from '@/components/shared/icons'
import { TransferQueue } from './TransferQueue'

export function DevicePanel() {
  const devices = useDeviceStore((s) => s.devices)
  const transfers = useDeviceStore((s) => s.transfers)
  const activeDeviceId = useLibraryStore((s) => s.activeDeviceId)
  const setActiveDevice = useLibraryStore((s) => s.setActiveDevice)

  if (!devices.length && !Object.keys(transfers).length) return null

  return (
    <div className="border-t border-ink-800 pt-2">
      {devices.length > 0 && (
        <div className="px-3 pb-1.5">
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
            Devices
          </p>
          {devices.map((d) => {
            const active = d.id === activeDeviceId
            return (
              // A button, like the shelf rows: it opens the device's books, and
              // a second click on the open one leaves them (so does "Library")
              <button
                key={d.id}
                onClick={() => setActiveDevice(active ? null : d.id)}
                aria-pressed={active}
                title={active ? 'Back to the library' : `Show the books on ${d.name}`}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                  active
                    ? 'bg-ink-800 font-medium text-parchment'
                    : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
                }`}
              >
                <DeviceIcon className="h-4 w-4 text-gold-400" />
                <span className="truncate">{d.name}</span>
                {d.freeBytes != null && (
                  <span className="ml-auto shrink-0 text-[10px] text-parchment-faint">
                    {(d.freeBytes / 1_073_741_824).toFixed(1)} GB free
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <TransferQueue />
    </div>
  )
}
