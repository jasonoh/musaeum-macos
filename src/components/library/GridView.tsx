import { useMemo } from 'react'
import { useLibraryStore } from '@/stores/library.store'
import { useBookNavigation } from '@/hooks/useBookNavigation'
import {
  rowWindow,
  useAnchoredScroll,
  useResetScrollOnResultChange,
  useScrollMetrics
} from '@/hooks/useVirtualRows'
import { resultSetKey } from '@/lib/resultSetIdentity'
import { libraryViewState } from '@/lib/library-emptiness'
import { BookCard, CARD_META_HEIGHT, CARD_META_MARGIN } from './BookCard'
import { EmptyLibrary } from '@/components/shared/EmptyLibrary'

/**
 * Layout constants mirroring the Tailwind classes on the scroll container.
 * The virtualizer derives column count and row height from these rather than
 * measuring cards, so any change here must move with the classes below.
 */
const PAD_X = 24 // px-6
const MIN_CARD_WIDTH = 140
const GAP_X = 20 // gap-x-5
const GAP_Y = 24 // gap-y-6
const PAD_TOP = 20 // py-5 — row 0 starts this far into the scroll content
const OVERSCAN_ROWS = 2

/** Column count `repeat(auto-fill, minmax(MIN_CARD_WIDTH, 1fr))` would pick. */
function columnCount(contentWidth: number): number {
  return Math.max(1, Math.floor((contentWidth + GAP_X) / (MIN_CARD_WIDTH + GAP_X)))
}

export function GridView() {
  const books = useLibraryStore((s) => s.books)
  const query = useLibraryStore((s) => s.query)
  const loading = useLibraryStore((s) => s.loading)
  const filters = useLibraryStore((s) => s.filters)
  const view = libraryViewState({ loading, query, filters, resultCount: books.length })
  const resultKey = useLibraryStore((s) =>
    resultSetKey({ query: s.query, filters: s.filters, sort: s.sort })
  )
  const bookIds = useMemo(() => books.map((b) => b.id), [books])
  const { ref, node, metrics } = useScrollMetrics<HTMLDivElement>()

  const contentWidth = Math.max(0, metrics.width - PAD_X * 2)
  const columns = columnCount(contentWidth)
  const cardWidth = (contentWidth - GAP_X * (columns - 1)) / columns
  // Cover is aspect-[2/3]; the meta block below it is fixed-height by design.
  const rowHeight = cardWidth * 1.5 + CARD_META_MARGIN + CARD_META_HEIGHT + GAP_Y
  const rows = Math.ceil(books.length / columns)
  const { start, end, padTop, padBottom } = rowWindow(rows, rowHeight, metrics, OVERSCAN_ROWS)

  // Registered before the anchor hook so its layout effect restores the anchor
  // first and this ensure-visible pass gets the final say on the selection
  useBookNavigation({
    node,
    columns,
    rowHeight,
    contentTop: PAD_TOP,
    ready: contentWidth > 0 && books.length > 0
  })
  // Must run before useAnchoredScroll below — see useResetScrollOnResultChange's
  // comment — so a result-set change's anchor is recorded against the reset
  // scrollTop, not a stale one.
  useResetScrollOnResultChange(node, resultKey)
  useAnchoredScroll(node, bookIds, columns, rowHeight, PAD_TOP, metrics.scrollTop)

  return (
    <div ref={ref} className="no-scroll-anchor h-full overflow-y-auto px-6 py-5">
      {view !== 'books' ? (
        <EmptyLibrary state={view} query={query} />
      ) : (
        // Width is 0 until the container is measured; rendering cards then
        // would flash them at zero width.
        contentWidth > 0 && (
          <>
            <div aria-hidden style={{ height: padTop }} />
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: GAP_X,
                rowGap: GAP_Y
              }}
            >
              {books.slice(start * columns, end * columns).map((book) => (
                <BookCard key={book.id} book={book} />
              ))}
            </div>
            <div aria-hidden style={{ height: padBottom }} />
          </>
        )
      )}
    </div>
  )
}
