import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useUIStore } from '@/stores/ui.store'
import { DevicePanel } from '@/components/device/DevicePanel'
import { FilterSidebar } from '@/components/shared/FilterSidebar'
import { ShelfList } from '@/components/layout/ShelfList'
import { GearIcon, RefreshIcon, WarningIcon } from '@/components/shared/icons'
import { canStartCatalogSync } from '@/lib/catalog-sync'
import { TRAFFIC_LIGHT_CENTER_Y, TRAFFIC_LIGHT_RIGHT_EDGE } from '@shared/window-chrome'

export function Sidebar() {
  const conflictCount = useUIStore((s) => s.conflictCount)
  const openModal = useUIStore((s) => s.openModal)
  const nasStatus = useNASStore((s) => s.status)
  const bookCount = useLibraryStore((s) => s.books.length)
  const catalogSync = useLibraryStore((s) => s.catalogSync)
  const refreshLibrary = useLibraryStore((s) => s.refreshLibrary)
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const libraryActive = activeShelfId === null
  const canReload = canStartCatalogSync(nasStatus?.state, catalogSync)
  const syncRunning = catalogSync?.outcome === 'running'

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
          pixel), so the caps' own half pixel is not reachable from CSS.

          The finish is the phone's wordmark (musaeum-ios `Wordmark.swift`):
          Roman, to match the icon's hairline M, embossed — a gold ramp face, a
          lit top edge, a dark lip below. The ramp's stops sit on the caps'
          band of the 1.5 line box (30–72%), not the box's full height: spread
          over the box, the caps drew only its dark lower half and read dimmer
          than the flat gold they replaced. The edges are `drop-shadow` filters,
          not `text-shadow`: under `bg-clip-text` the glyphs are transparent and
          a text-shadow would show through them. */}
      <div className="app-drag relative h-14 shrink-0">
        <h1
          className="absolute -translate-y-1/2 translate-x-[0.13em] bg-[linear-gradient(to_bottom,rgb(var(--gold-300))_30%,rgb(var(--gold-400))_52%,rgb(var(--gold-500))_72%)] bg-clip-text text-center font-display text-[15px] font-normal tracking-[0.18em] text-transparent [filter:drop-shadow(0_-0.5px_0_rgb(var(--gold-300)/0.55))_drop-shadow(0_1px_0.6px_rgb(var(--scrim)/0.7))]"
          style={{ left: TRAFFIC_LIGHT_RIGHT_EDGE, right: 0, top: TRAFFIC_LIGHT_CENTER_Y }}
        >
          MUSAEUM
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        <nav className="mb-4 px-2">
          {/* Navigation, not a label: clicking it leaves whatever shelf is open
              (D9). The highlight is the same pair the shelf rows use, which is
              what makes "where am I" one glance rather than two rules.

              A `role="button"` div rather than a button element, because the
              row's reload control is a real button and HTML forbids one button
              inside another: the row stays one target, the reload icon keeps
              its own handler (and stops its click reaching here, so reloading
              does not also navigate), and nothing about the geometry or the
              highlight moves. */}
          <div
            role="button"
            tabIndex={0}
            aria-pressed={libraryActive}
            onClick={() => setActiveShelf(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveShelf(null)
              }
            }}
            className={`flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] ${
              libraryActive
                ? 'bg-ink-800 font-medium text-parchment'
                : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
            }`}
          >
            Library
            {/* Reload Library (also ⌘R): re-reads the shared catalog, which is
                how books added on another machine or from the phone arrive
                here without a restart. It spins for any running job — a
                reload that finds the catalog unreadable becomes the rebuild,
                and the status bar says which. */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                void refreshLibrary()
              }}
              disabled={!canReload}
              title="Reload Library (⌘R)"
              aria-label="Reload Library"
              className="-my-0.5 rounded p-0.5 text-parchment-faint transition-colors hover:text-gold-400 disabled:pointer-events-none disabled:opacity-40"
            >
              <RefreshIcon className={`h-3.5 w-3.5 ${syncRunning ? 'animate-spin' : ''}`} />
            </button>
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
              descriptions. This column is for going places — the one
              exception is the reload icon on the Library row, because
              picking up another machine's additions is routine, not
              maintenance. Shelves are places too, which is why they follow
              the Library row rather than sitting below the filters. */}
        </nav>

        {/* Shelves are navigation — the same column as Library, above the
            facets. See the note in the `nav` block above. */}
        <ShelfList />
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
