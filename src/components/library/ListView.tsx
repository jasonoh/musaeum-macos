import type { Book, SortField } from '@shared/book.types'
import { defaultSortDirection, seriesDisplay } from '@shared/book.types'
import { modifiersFrom } from '@/lib/selection'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useReaderStore } from '@/stores/reader.store'
import { selectionCount, useUIStore } from '@/stores/ui.store'
import { useBookNavigation } from '@/hooks/useBookNavigation'
import { rowWindow, useResetScrollOnResultChange, useScrollMetrics } from '@/hooks/useVirtualRows'
import { resultSetKey } from '@/lib/resultSetIdentity'
import { libraryViewState } from '@/lib/library-emptiness'
import { EmptyLibrary } from '@/components/shared/EmptyLibrary'
import { CheckIcon, SortArrowIcon, StarIcon } from '@/components/shared/icons'

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
const COLUMNS: {
  label: string
  width: string
  field?: SortField
  align?: 'right'
  /** The checkbox column: rendered by its own header and row cells. */
  select?: true
}[] = [
  { label: '', width: 'w-10', select: true },
  { label: 'Title', width: 'w-[28%]', field: 'title' },
  { label: 'Author', width: 'w-[20%]', field: 'author' },
  { label: 'Series', width: 'w-[18%]', field: 'series' },
  { label: 'Added', width: 'w-[12%]', field: 'date_added' },
  { label: 'Formats', width: 'w-[10%]' },
  { label: 'Rating', width: 'w-[10%]', field: 'rating' }
]

function Rating({ value }: { value: number | null }) {
  if (!value) return <span className="block text-[13px] leading-5 text-parchment-faint">—</span>
  return (
    <span className="flex h-5 items-center gap-px text-gold-400">
      {Array.from({ length: value }, (_, i) => (
        <StarIcon key={i} className="h-3 w-3" filled />
      ))}
    </span>
  )
}

function Row({ book }: { book: Book }) {
  const select = useUIStore((s) => s.select)
  const toggleBookSelection = useUIStore((s) => s.toggleBookSelection)
  const selected = useUIStore((s) => s.selection.ids.has(book.id))
  const openContextMenuFor = useUIStore((s) => s.openContextMenuFor)

  return (
    <tr
      onClick={(e) => select(book.id, modifiersFrom(e))}
      // Same gesture as the grid: single click selects, double click reads
      onDoubleClick={() => useReaderStore.getState().openBook(book)}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenuFor({ bookId: book.id, x: e.clientX, y: e.clientY })
      }}
      style={{ height: ROW_HEIGHT - 1 }} // the collapsed border supplies the 1px
      // `select-none` because double-click opens the book: without it the
      // gesture also selects the word under the cursor, leaving a stray
      // highlight behind the reader overlay
      className={`cursor-default select-none border-b border-ink-800/60 transition-colors ${
        selected ? 'bg-gold-500/10' : 'hover:bg-ink-850'
      }`}
    >
      {/* The 20px line and block-level child keep this cell inside ROW_HEIGHT.
          stopPropagation so ticking a box doesn't also run the row's click and
          collapse the selection to this one book. */}
      <td
        className="w-10 py-2 pl-6 pr-2"
        onClick={(e) => {
          e.stopPropagation()
          toggleBookSelection(book.id)
        }}
      >
        <span className="flex h-5 items-center">
          <span
            className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors ${
              selected ? 'border-gold-400 bg-gold-500/30 text-gold-300' : 'border-ink-600'
            }`}
          >
            {selected && <CheckIcon className="h-2.5 w-2.5" />}
          </span>
        </span>
      </td>
      <td className="max-w-0 truncate px-3 py-2 font-display text-[13px] leading-5 text-parchment">
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
    <th
      className={`${width} ${padding} font-semibold`}
      aria-sort={ariaSort(active, sort.direction)}
    >
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

/**
 * Select-all box. "All" means every book currently loaded — that is, under
 * the active search and filters — which is the only meaning that matches
 * what is on screen.
 */
function SelectAllHeaderCell() {
  const books = useLibraryStore((s) => s.books)
  const count = useUIStore(selectionCount)
  const selectAllBooks = useUIStore((s) => s.selectAllBooks)
  const clearSelection = useUIStore((s) => s.clearSelection)

  const all = books.length > 0 && count === books.length
  const some = count > 0 && !all

  return (
    <th className="w-10 py-2 pl-6 pr-2">
      <button
        role="checkbox"
        aria-checked={all ? 'true' : some ? 'mixed' : 'false'}
        aria-label={all ? 'Deselect all books' : 'Select all books'}
        onClick={() => (all ? clearSelection() : selectAllBooks())}
        className="flex h-5 items-center"
      >
        <span
          className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors ${
            all || some ? 'border-gold-400 bg-gold-500/30 text-gold-300' : 'border-ink-600'
          }`}
        >
          {all && <CheckIcon className="h-2.5 w-2.5" />}
          {some && <span className="h-0.5 w-2 rounded bg-gold-400" />}
        </span>
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
  const query = useLibraryStore((s) => s.query)
  const loading = useLibraryStore((s) => s.loading)
  const filters = useLibraryStore((s) => s.filters)
  // The same fact the write-gating components read: this pane's first-run copy
  // is a promise that a book dropped or picked here will land, and only
  // 'connected' keeps it (see `library-emptiness.ts`)
  const storageConnected = useNASStore((s) => s.status?.state === 'connected')
  const view = libraryViewState({
    loading,
    query,
    filters,
    resultCount: books.length,
    storageConnected
  })
  const resultKey = useLibraryStore((s) =>
    resultSetKey({ query: s.query, filters: s.filters, sort: s.sort })
  )
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
  // See useResetScrollOnResultChange's comment on GridView's copy of this call
  // — the list has no anchor hook to order against, but the same
  // selection-wins composition with useBookNavigation's ensure-visible pass
  // applies here too.
  useResetScrollOnResultChange(node, resultKey)

  return (
    <div ref={ref} className="no-scroll-anchor h-full overflow-y-auto">
      {/* The column headers go with the rows: a header strip over "Your library
          awaits" reads as a table with nothing in it rather than as a place to
          start, and list mode is a persisted preference — so this empty pane is
          the only one some users ever see. */}
      {view !== 'books' ? (
        <EmptyLibrary state={view} query={query} />
      ) : (
        <table className="w-full table-fixed border-collapse">
          <thead className="sticky top-0 z-10 bg-ink-900">
            <tr className="border-b border-ink-700 text-left text-[11px] font-semibold uppercase tracking-wider text-parchment-faint">
              {COLUMNS.map((c, i) =>
                c.select ? (
                  <SelectAllHeaderCell key="select" />
                ) : (
                  <HeaderCell
                    key={c.label}
                    label={c.label}
                    width={c.width}
                    field={c.field}
                    first={i === 0}
                    last={i === COLUMNS.length - 1}
                  />
                )
              )}
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
      )}
    </div>
  )
}
