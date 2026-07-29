import type { Book, SortField } from '@shared/book.types'
import { defaultSortDirection, seriesDisplay } from '@shared/book.types'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { SortArrowIcon, StarIcon } from '@/components/shared/icons'

/** Column definitions; `field` omitted means the column isn't sortable. */
const COLUMNS: { label: string; width: string; field?: SortField; align?: 'right' }[] = [
  { label: 'Title', width: 'w-[30%]', field: 'title' },
  { label: 'Author', width: 'w-[20%]', field: 'author' },
  { label: 'Series', width: 'w-[18%]', field: 'series' },
  { label: 'Added', width: 'w-[12%]', field: 'date_added' },
  { label: 'Formats', width: 'w-[10%]' },
  { label: 'Rating', width: 'w-[10%]', field: 'rating' }
]

function Rating({ value }: { value: number | null }) {
  if (!value) return <span className="text-parchment-faint">—</span>
  return (
    <span className="flex gap-px text-gold-400">
      {Array.from({ length: value }, (_, i) => (
        <StarIcon key={i} className="h-3 w-3" filled />
      ))}
    </span>
  )
}

function Row({ book }: { book: Book }) {
  const selectBook = useUIStore((s) => s.selectBook)
  const selected = useUIStore((s) => s.selectedBookId === book.id)
  const openContextMenu = useUIStore((s) => s.openContextMenu)

  return (
    <tr
      onClick={() => selectBook(book.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu({ bookId: book.id, x: e.clientX, y: e.clientY })
      }}
      className={`cursor-default border-b border-ink-800/60 transition-colors ${
        selected ? 'bg-gold-500/10' : 'hover:bg-ink-850'
      }`}
    >
      <td className="max-w-0 truncate py-2 pl-6 pr-3 font-display text-[13px] text-parchment">
        {book.title}
      </td>
      <td className="max-w-0 truncate px-3 py-2 text-[13px] text-parchment-dim">
        {book.author ?? '—'}
      </td>
      <td className="max-w-0 truncate px-3 py-2 text-[13px] italic text-gold-400/70">
        {book.seriesName ? seriesDisplay(book.seriesName, book.seriesIndex) : ''}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-[12px] tabular-nums text-parchment-faint">
        {book.dateAdded?.slice(0, 10) ?? ''}
      </td>
      <td className="px-3 py-2">
        <span className="flex gap-1">
          {book.formats.map((f) => (
            <span
              key={f}
              className="rounded border border-ink-600 px-1 py-px text-[10px] uppercase text-parchment-faint"
            >
              {f}
            </span>
          ))}
        </span>
      </td>
      <td className="px-3 py-2 pr-6">
        <Rating value={book.rating} />
      </td>
    </tr>
  )
}

/**
 * Column header. Clicking a sortable one sorts by that field; clicking the
 * active field again flips the direction.
 */
function HeaderCell({
  label,
  width,
  field,
  first,
  last
}: {
  label: string
  width: string
  field?: SortField
  first: boolean
  last: boolean
}) {
  const sort = useLibraryStore((s) => s.sort)
  const setSort = useLibraryStore((s) => s.setSort)
  const padding = `${first ? 'pl-6 pr-3' : last ? 'px-3 pr-6' : 'px-3'} py-2`

  if (!field) return <th className={`${width} ${padding}`}>{label}</th>

  const active = sort.field === field
  return (
    <th className={`${width} ${padding} font-semibold`} aria-sort={ariaSort(active, sort.direction)}>
      <button
        onClick={() =>
          setSort({
            field,
            direction: active
              ? sort.direction === 'asc'
                ? 'desc'
                : 'asc'
              : defaultSortDirection(field)
          })
        }
        className={`group -mx-1 flex items-center gap-1 rounded px-1 py-0.5 uppercase tracking-wider transition-colors ${
          active ? 'text-gold-300' : 'hover:text-parchment'
        }`}
      >
        {label}
        <SortArrowIcon
          className={`h-3 w-3 transition-opacity ${
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
          }`}
          up={active ? sort.direction === 'asc' : defaultSortDirection(field) === 'asc'}
        />
      </button>
    </th>
  )
}

function ariaSort(active: boolean, direction: 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (!active) return 'none'
  return direction === 'asc' ? 'ascending' : 'descending'
}

export function ListView() {
  const books = useLibraryStore((s) => s.books)

  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full table-fixed border-collapse">
        <thead className="sticky top-0 z-10 bg-ink-900">
          <tr className="border-b border-ink-700 text-left text-[11px] font-semibold uppercase tracking-wider text-parchment-faint">
            {COLUMNS.map((c, i) => (
              <HeaderCell
                key={c.label}
                label={c.label}
                width={c.width}
                field={c.field}
                first={i === 0}
                last={i === COLUMNS.length - 1}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {books.map((book) => (
            <Row key={book.id} book={book} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
