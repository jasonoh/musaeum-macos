import { useLibraryStore } from '@/stores/library.store'
import { rowWindow, useScrollMetrics } from '@/hooks/useVirtualRows'
import { BookCard, CARD_META_HEIGHT, CARD_META_MARGIN } from './BookCard'
import { BookIcon } from '@/components/shared/icons'

/**
 * Layout constants mirroring the Tailwind classes on the scroll container.
 * The virtualizer derives column count and row height from these rather than
 * measuring cards, so any change here must move with the classes below.
 */
const PAD_X = 24 // px-6
const MIN_CARD_WIDTH = 140
const GAP_X = 20 // gap-x-5
const GAP_Y = 24 // gap-y-6
const OVERSCAN_ROWS = 2

/** Column count `repeat(auto-fill, minmax(MIN_CARD_WIDTH, 1fr))` would pick. */
function columnCount(contentWidth: number): number {
  return Math.max(1, Math.floor((contentWidth + GAP_X) / (MIN_CARD_WIDTH + GAP_X)))
}

function EmptyLibrary({ query }: { query: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-parchment-faint">
      <BookIcon className="h-10 w-10" />
      {query.trim() ? (
        <p className="text-sm">Nothing matches “{query.trim()}”</p>
      ) : (
        <>
          <p className="font-display text-lg text-parchment-dim">Your library awaits</p>
          <p className="max-w-xs text-center text-sm">
            Drag EPUB, MOBI, or AZW3 files anywhere in this window to add them
          </p>
        </>
      )}
    </div>
  )
}

export function GridView() {
  const books = useLibraryStore((s) => s.books)
  const query = useLibraryStore((s) => s.query)
  const { ref, metrics } = useScrollMetrics<HTMLDivElement>()

  const contentWidth = Math.max(0, metrics.width - PAD_X * 2)
  const columns = columnCount(contentWidth)
  const cardWidth = (contentWidth - GAP_X * (columns - 1)) / columns
  // Cover is aspect-[2/3]; the meta block below it is fixed-height by design.
  const rowHeight = cardWidth * 1.5 + CARD_META_MARGIN + CARD_META_HEIGHT + GAP_Y
  const rows = Math.ceil(books.length / columns)
  const { start, end, padTop, padBottom } = rowWindow(rows, rowHeight, metrics, OVERSCAN_ROWS)

  return (
    <div ref={ref} className="no-scroll-anchor h-full overflow-y-auto px-6 py-5">
      {!books.length ? (
        <EmptyLibrary query={query} />
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
