import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { DevicePanel } from '@/components/device/DevicePanel'
import { FilterSidebar } from '@/components/shared/FilterSidebar'
import { GearIcon, WarningIcon } from '@/components/shared/icons'
import { TRAFFIC_LIGHT_CENTER_Y, TRAFFIC_LIGHT_RIGHT_EDGE } from '@shared/window-chrome'

export function Sidebar() {
  const conflictCount = useUIStore((s) => s.conflictCount)
  const openModal = useUIStore((s) => s.openModal)
  const nasStatus = useNASStore((s) => s.status)
  const bookCount = useLibraryStore((s) => s.books.length)

  // State → token, not state → word: D4 owns the copy, and a colour is a
  // presentation choice this component keeps. It cannot disagree with the label
  // beside it, because both are exhaustive over the same five states.
  const nasDot =
    nasStatus?.state === 'connected'
      ? 'bg-ok-500'
      : nasStatus?.state === 'reconnecting'
        ? 'bg-gold-400 animate-pulse'
        : 'bg-danger-500'

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
      {/* Traffic-light clearance; the wordmark row doubles as a drag handle.
          The wordmark is centred in the space the dots leave — between them and
          the column's right edge — on the line through their centres, which is
          why the row is a positioning context rather than a padded flex line
          (see window-chrome.ts for where those numbers come from). The
          translate is half the trailing letter-space, which no eye reads.

          The box, not the caps, is what can be centred: a line box centres its
          leading, and text paints on a whole-pixel grid here (measured — `top`
          anywhere from 25.5 to 26.25 paints identically, +1px moves a full
          pixel), so the caps' own half pixel is not reachable from CSS. */}
      <div className="app-drag relative h-14 shrink-0">
        <h1
          className="absolute -translate-y-1/2 translate-x-[0.13em] text-center font-display text-[15px] font-semibold tracking-[0.18em] text-gold-400"
          style={{ left: TRAFFIC_LIGHT_RIGHT_EDGE, right: 0, top: TRAFFIC_LIGHT_CENTER_Y }}
        >
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

          {/* Migration, the catalog refresh and the catalog rebuild all used to
              sit here as three sibling rows. They are not navigation: one is an
              acquisition that happens once (plus a re-runnable top-up), one is a
              poll, and one is break-glass that costs 1,281 s over SMB at library
              scale. Acquisition now lives on the empty view and the Add Books
              control; both maintenance actions live in Settings → Library, with
              descriptions. This column is for going places. */}
        </nav>

        <FilterSidebar />
      </div>

      <DevicePanel />

      {/* The status row doubles as the Settings entry point, so an
          unconfigured or offline library leads straight to where it's fixed */}
      <button
        onClick={() => openModal('settings')}
        title="Settings"
        className="flex items-center gap-2 border-t border-ink-800 px-4 py-2.5 text-left text-[12px] text-parchment-faint hover:bg-ink-800 hover:text-parchment-dim"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${nasDot}`} />
        {/* The words come from the main process (D4), and they are the *same*
            words the Settings row renders — one label, so the two rows cannot
            disagree. Blank only until the first status read lands. */}
        <span className="truncate">{nasStatus?.copy.label}</span>
        <GearIcon className="ml-auto h-3.5 w-3.5 shrink-0" />
      </button>
    </aside>
  )
}
