import type { Book, SortField } from '@shared/book.types'
import { defaultSortDirection, seriesDisplay } from '@shared/book.types'
import { useLibraryStore } from '@/stores/library.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'
import { useBookNavigation } from '@/hooks/useBookNavigation'
import { rowWindow, useScrollMetrics } from '@/hooks/useVirtualRows'
import { SortArrowIcon, StarIcon } from '@/components/shared/icons'

/**
 * Row pitch (px) the virtualizer assumes: py-2 (16) + one 20px line, plus the
 * 1px collapsed bottom border, which sits outside the height set on the <tr>.
 * Every cell carries explicit leading and every cell's child is block-level —
 * an inline child would pick up the table's own line strut and silently push
 * the row past this (which rating's em-dash fallback used to do).
 */
const ROW_HEIGHT = 37
const OVERSCAN_ROWS = 8
/** Sticky <thead> occupies the top of the scroll content, ahead of row 0. */
const HEADER_HEIGHT = 37

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
  if (!value)
    return <span className="block text-[13px] leading-5 text-parchment-faint">—</span>
  return (
    <span className="flex h-5 items-center gap-px text-gold-400">
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
      // Same gesture as the grid: single click selects, double click reads
      onDoubleClick={() => useReaderStore.getState().openBook(book)}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu({ bookId: book.id, x: e.clientX, y: e.clientY })
      }}
      style={{ height: ROW_HEIGHT - 1 }} // the collapsed border supplies the 1px
      className={`cursor-default border-b border-ink-800/60 transition-colors ${
        selected ? 'bg-gold-500/10' : 'hover:bg-ink-850'
      }`}
    >
      <td className="max-w-0 truncate py-2 pl-6 pr-3 font-display text-[13px] leading-5 text-parchment">
        {book.title}
      </td>
      <td className="max-w-0 truncate px-3 py-2 text-[13px] leading-5 text-parchment-dim">
        {book.author ?? '—'}
      </td>
      <td className="max-w-0 truncate px-3 py-2 text-[13px] italic leading-5 text-gold-400/70">
        {book.seriesName ? seriesDisplay(book.seriesName, book.seriesIndex) : ''}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-[12px] leading-5 tabular-nums text-parchment-faint">
        {book.dateAdded?.slice(0, 10) ?? ''}
      </td>
      <td className="px-3 py-2">
        <span className="flex gap-1">
          {book.formats.map((f) => (
            <span
              key={f}
              className="rounded border border-ink-600 px-1 text-[10px] uppercase leading-[18px] text-parchment-faint"
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

/** Spacer standing in for the windowed-out rows above or below the viewport. */
function Spacer({ height }: { height: number }) {
  if (height <= 0) return null
  return (
    <tr aria-hidden>
      <td colSpan={COLUMNS.length} style={{ height, padding: 0, border: 0 }} />
    </tr>
  )
}

export function ListView() {
  const books = useLibraryStore((s) => s.books)
  const { ref, node, metrics } = useScrollMetrics<HTMLDivElement>()
  const { start, end, padTop, padBottom } = rowWindow(
    books.length,
    ROW_HEIGHT,
    { ...metrics, scrollTop: metrics.scrollTop - HEADER_HEIGHT },
    OVERSCAN_ROWS
  )

  useBookNavigation({
    node,
    columns: 1,
    rowHeight: ROW_HEIGHT,
    // The sticky <thead> both precedes row 0 and covers the top of the viewport
    contentTop: HEADER_HEIGHT,
    stickyTop: HEADER_HEIGHT,
    ready: books.length > 0
  })

  return (
    <div ref={ref} className="no-scroll-anchor h-full overflow-y-auto">
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
          <Spacer height={padTop} />
          {books.slice(start, end).map((book) => (
            <Row key={book.id} book={book} />
          ))}
          <Spacer height={padBottom} />
        </tbody>
      </table>
    </div>
  )
}
