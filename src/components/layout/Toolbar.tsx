import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { SearchBar } from '@/components/shared/SearchBar'
import { GridIcon, ListIcon } from '@/components/shared/icons'
import type { SortField } from '@shared/book.types'

const SORT_OPTIONS: { field: SortField; direction: 'asc' | 'desc'; label: string }[] = [
  { field: 'title', direction: 'asc', label: 'Title A–Z' },
  { field: 'title', direction: 'desc', label: 'Title Z–A' },
  { field: 'author', direction: 'asc', label: 'Author A–Z' },
  { field: 'series', direction: 'asc', label: 'Series' },
  { field: 'date_added', direction: 'desc', label: 'Recently Added' },
  { field: 'date_added', direction: 'asc', label: 'Oldest First' },
  { field: 'rating', direction: 'desc', label: 'Rating' },
  { field: 'read_status', direction: 'asc', label: 'Read Status' }
]

export function Toolbar() {
  const viewMode = useUIStore((s) => s.viewMode)
  const setViewMode = useUIStore((s) => s.setViewMode)
  const sort = useLibraryStore((s) => s.sort)
  const setSort = useLibraryStore((s) => s.setSort)

  const sortValue = `${sort.field}:${sort.direction}`

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
        {SORT_OPTIONS.map((o) => (
          <option key={`${o.field}:${o.direction}`} value={`${o.field}:${o.direction}`}>
            Sort: {o.label}
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
