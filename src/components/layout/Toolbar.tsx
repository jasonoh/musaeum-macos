import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { SearchBar } from '@/components/shared/SearchBar'
import { GridIcon, ListIcon } from '@/components/shared/icons'
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
    <header className="app-drag flex h-14 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-900/60 px-4">
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
