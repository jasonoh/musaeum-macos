import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { DevicePanel } from '@/components/device/DevicePanel'
import { FilterSidebar } from '@/components/shared/FilterSidebar'
import { WarningIcon } from '@/components/shared/icons'

export function Sidebar() {
  const conflictCount = useUIStore((s) => s.conflictCount)
  const openModal = useUIStore((s) => s.openModal)
  const nasStatus = useNASStore((s) => s.status)
  const bookCount = useLibraryStore((s) => s.books.length)

  const nasDot =
    nasStatus?.state === 'connected'
      ? 'bg-emerald-500'
      : nasStatus?.state === 'reconnecting'
        ? 'bg-gold-400 animate-pulse'
        : 'bg-red-500'

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      {/* Traffic-light clearance; the wordmark row doubles as a drag handle */}
      <div className="app-drag flex h-14 shrink-0 items-end px-4 pb-2 pl-[76px]">
        <h1 className="font-display text-[15px] font-semibold tracking-[0.18em] text-gold-400">
          MUSAEUM
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        <nav className="mb-4 px-2">
          <div className="flex w-full items-center gap-2 rounded-md bg-ink-800 px-2 py-1.5 text-[13px] font-medium text-parchment">
            Library
            <span className="ml-auto text-[11px] tabular-nums text-parchment-faint">
              {bookCount}
            </span>
          </div>

          {conflictCount > 0 && (
            <button
              onClick={() => openModal('conflicts')}
              className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
            >
              <WarningIcon className="h-3.5 w-3.5 text-gold-400" />
              Needs Review
              <span className="ml-auto rounded-full bg-gold-500 px-1.5 py-px text-[11px] font-semibold tabular-nums text-ink-950">
                {conflictCount}
              </span>
            </button>
          )}

          <button
            onClick={() => openModal('migration')}
            className="mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
          >
            Migrate from Calibre…
          </button>
        </nav>

        <FilterSidebar />
      </div>

      <DevicePanel />

      <div className="flex items-center gap-2 border-t border-ink-800 px-4 py-2.5 text-[12px] text-parchment-faint">
        <span className={`h-2 w-2 rounded-full ${nasDot}`} />
        {nasStatus?.state === 'connected'
          ? 'Library connected'
          : nasStatus?.state === 'reconnecting'
            ? 'Reconnecting…'
            : nasStatus?.state === 'unconfigured'
              ? 'Not configured'
              : 'Offline'}
      </div>
    </aside>
  )
}
