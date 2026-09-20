import { useEffect, useState } from 'react'
import { TITLEBAR_STRIP_HEIGHT } from '@shared/window-chrome'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { SearchBar } from '@/components/shared/SearchBar'
import {
  BookIcon,
  ChevronIcon,
  FolderIcon,
  GridIcon,
  ListIcon,
  PlusIcon
} from '@/components/shared/icons'
import { importBooksFromDialog } from '@/lib/add-books'
import type { BookSort, SortField } from '@shared/book.types'
import { sortLabel } from '@shared/book.types'

/** Curated shortcuts; labels come from the shared map so both sort UIs agree. */
const SORT_OPTIONS: BookSort[] = [
  { field: 'title', direction: 'asc' },
  { field: 'title', direction: 'desc' },
  { field: 'author', direction: 'asc' },
  { field: 'series', direction: 'asc' },
  { field: 'date_added', direction: 'desc' },
  { field: 'date_added', direction: 'asc' },
  { field: 'rating', direction: 'desc' },
  { field: 'read_status', direction: 'asc' }
]

const key = (s: BookSort) => `${s.field}:${s.direction}`

/**
 * Add Books — the app's on-ramp. It offers both ways in: the native picker, and
 * the Calibre wizard, which stays reachable after first run because its PDF
 * top-up is a job you run again (design D4/D5).
 *
 * The open state is local to this control and never reaches a store: nothing
 * else needs to know the menu is open, and the native menu is built once, so
 * there is no state for it to sync with (`menu-and-branding.md`).
 *
 * ⌘O runs the first item directly (`useMenuCommands`), not a second picker —
 * the two doors call the same `importBooksFromDialog`.
 */
function AddBooksControl() {
  const openModal = useUIStore((s) => s.openModal)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  /** Both items dismiss the menu first: the work outlives it, and a menu left
   *  open over a started job reads as if nothing happened. */
  const choose = (run: () => void) => () => {
    setOpen(false)
    run()
  }

  return (
    <div className="app-no-drag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add Books"
        className="flex items-center gap-1.5 rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[13px] text-parchment-dim hover:text-parchment"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        Add Books
        <ChevronIcon className="h-3 w-3" open={open} />
      </button>

      {open && (
        <>
          {/* Click anywhere else to dismiss — the same shape the book context
              menu uses, so one habit covers both menus */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label="Add Books"
            className="absolute left-0 top-full z-50 mt-1 w-56 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
          >
            <AddBooksMenuItem
              icon={<BookIcon className="h-3.5 w-3.5" />}
              label="Import files…"
              onClick={choose(() => void importBooksFromDialog())}
            />
            <AddBooksMenuItem
              icon={<FolderIcon className="h-3.5 w-3.5" />}
              label="Migrate from Calibre…"
              onClick={choose(() => openModal('migration'))}
            />
          </div>
        </>
      )}
    </div>
  )
}

function AddBooksMenuItem({
  icon,
  label,
  onClick
}: {
  icon: React.ReactNode
  label: string
  onClick(): void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
    >
      {icon}
      {label}
    </button>
  )
}

export function Toolbar() {
  const viewMode = useUIStore((s) => s.viewMode)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const sort = useLibraryStore((s) => s.sort)
  const setSort = useLibraryStore((s) => s.setSort)

  const sortValue = key(sort)
  // A list-view header can select a combination this list doesn't carry (e.g.
  // Author Z–A); append it so the select never falls back to a wrong option
  const options = SORT_OPTIONS.some((o) => key(o) === sortValue)
    ? SORT_OPTIONS
    : [...SORT_OPTIONS, sort]

  return (
    <header
      className="app-drag flex shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/60 px-4"
      style={{ height: TITLEBAR_STRIP_HEIGHT }}
    >
      <AddBooksControl />

      <div className="flex flex-1 justify-center">
        <SearchBar />
      </div>

      <select
        value={sortValue}
        onChange={(e) => {
          const [field, direction] = e.target.value.split(':')
          setSort({ field: field as SortField, direction: direction as 'asc' | 'desc' })
        }}
        className="app-no-drag rounded-md border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-parchment-dim hover:text-parchment"
        aria-label="Sort books"
      >
        {options.map((o) => (
          <option key={key(o)} value={key(o)}>
            Sort: {sortLabel(o)}
          </option>
        ))}
      </select>

      <div className="app-no-drag flex overflow-hidden rounded-md border border-ink-700">
        {(
          [
            ['grid', GridIcon],
            ['list', ListIcon]
          ] as const
        ).map(([mode, Icon]) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            aria-label={`${mode} view`}
            className={`px-2.5 py-1.5 transition-colors ${
              viewMode === mode
                ? 'bg-gold-500/20 text-gold-300'
                : 'bg-ink-850 text-parchment-faint hover:text-parchment'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
    </header>
  )
}
