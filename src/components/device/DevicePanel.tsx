import { useDeviceStore } from '@/stores/device.store'
import { DeviceIcon } from '@/components/shared/icons'
import { TransferQueue } from './TransferQueue'

export function DevicePanel() {
  const devices = useDeviceStore((s) => s.devices)
  const transfers = useDeviceStore((s) => s.transfers)

  if (!devices.length && !Object.keys(transfers).length) return null

  return (
    <div className="border-t border-ink-800 pt-2">
      {devices.length > 0 && (
        <div className="px-3 pb-1.5">
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
            Devices
          </p>
          {devices.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-parchment-dim"
            >
              <DeviceIcon className="h-4 w-4 text-gold-400" />
              <span className="truncate">{d.name}</span>
              {d.freeBytes != null && (
                <span className="ml-auto text-[10px] text-parchment-faint">
                  {(d.freeBytes / 1_073_741_824).toFixed(1)} GB free
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <TransferQueue />
    </div>
  )
}
