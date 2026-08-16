import { memo } from 'react'
import type { Book } from '@shared/book.types'
import { seriesDisplay } from '@shared/book.types'
import { modifiersFrom } from '@/lib/selection'
import { bookOnDevices, useDeviceStore } from '@/stores/device.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'
import { DeviceIcon, TrashIcon } from '@/components/shared/icons'

/**
 * Card geometry below the cover, in px. Fixed rather than content-sized so
 * every card in the grid is exactly `coverWidth × 1.5 + CARD_META_MARGIN +
 * CARD_META_HEIGHT` tall — GridView's virtualizer computes row offsets from
 * these instead of measuring the DOM. `CARD_META_HEIGHT` is title (2 lines ×
 * leading-4) + author (mt-0.5 + leading-4) + series (same).
 */
export const CARD_META_HEIGHT = 68
export const CARD_META_MARGIN = 8

export function coverUrl(book: Book, size: 'thumb' | 'full'): string | null {
  const path = size === 'thumb' ? book.coverThumbPath : book.coverFullPath
  return path ? `musaeum://cover/${book.id}/${size}` : null
}

/** Serif placeholder for books whose covers haven't been hydrated yet. */
export function CoverFallback({ book, large }: { book: Book; large?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-b from-ink-700 to-ink-800 p-3">
      <div className="h-px w-8 bg-gold-500/50" />
      <span
        className={`line-clamp-4 text-center font-display leading-snug text-parchment-dim ${
          large ? 'text-lg' : 'text-[11px]'
        }`}
      >
        {book.title}
      </span>
      <div className="h-px w-8 bg-gold-500/50" />
    </div>
  )
}

export const BookCard = memo(function BookCard({ book }: { book: Book }) {
  const select = useUIStore((s) => s.select)
  // A boolean selector, so zustand re-renders only the cards whose membership
  // actually changed rather than every mounted card on every selection change
  const selected = useUIStore((s) => s.selection.ids.has(book.id))
  const openContextMenuFor = useUIStore((s) => s.openContextMenuFor)
  const requestDelete = useUIStore((s) => s.requestDelete)
  const thumb = coverUrl(book, 'thumb')
  const onDevice = useDeviceStore((s) => bookOnDevices(s, book.id).length > 0)

  return (
    <div
      className="group relative"
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenuFor({ bookId: book.id, x: e.clientX, y: e.clientY })
      }}
    >
      <button
        onClick={(e) => select(book.id, modifiersFrom(e))}
        // Read through `getState` rather than subscribing: nothing on the card
        // renders from the reader, and this one is memoized per book.
        //
        // No `select-none` here, unlike ListView's row: measured, not assumed —
        // Blink starts no word selection on a double-click inside a <button>,
        // so opening a book from the grid leaves nothing highlighted behind the
        // reader. That protection comes from the element, not from this class
        // list: if the card ever stops being a <button>, add `select-none`.
        onDoubleClick={() => useReaderStore.getState().openBook(book)}
        className="flex w-full flex-col rounded-md text-left focus-visible:ring-2 focus-visible:ring-gold-400/70"
      >
        <div
          className={`relative aspect-[2/3] w-full overflow-hidden rounded-md shadow-cover transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-cover-lift ${
            selected ? 'ring-2 ring-gold-400' : 'ring-1 ring-white/5 group-hover:ring-gold-500/40'
          }`}
        >
          {thumb ? (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <CoverFallback book={book} />
          )}
          {book.readStatus === 'read' && (
            <div className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-gold-400 shadow" />
          )}
          {onDevice && (
            <div
              className="absolute left-1.5 top-1.5 rounded-full bg-ink-950/70 p-1 text-gold-400 shadow"
              title="On device"
            >
              <DeviceIcon className="h-2.5 w-2.5" />
            </div>
          )}
        </div>

        <div
          className="overflow-hidden px-0.5"
          style={{ height: CARD_META_HEIGHT, marginTop: CARD_META_MARGIN }}
        >
          <p className="line-clamp-2 font-display text-[13px] leading-4 text-parchment group-hover:text-gold-300">
            {book.title}
          </p>
          {book.author && (
            <p className="mt-0.5 truncate text-[11px] leading-4 text-parchment-faint">
              {book.author}
            </p>
          )}
          {book.seriesName && (
            <p className="mt-0.5 truncate text-[11px] italic leading-4 text-gold-400/70">
              {seriesDisplay(book.seriesName, book.seriesIndex)}
            </p>
          )}
        </div>
      </button>

      {/* Overlay mirroring the cover's box so the delete control can sit inside
          the artwork while staying a sibling of the card button (nested buttons
          are invalid HTML). Matches the cover's hover lift. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[2/3] transition-transform duration-200 group-hover:-translate-y-1">
        <button
          onClick={() => requestDelete(book.id)}
          title="Delete book"
          aria-label={`Delete ${book.title}`}
          className="pointer-events-auto absolute bottom-1.5 right-1.5 rounded-full bg-ink-950/80 p-1.5 text-parchment-faint opacity-0 shadow transition-colors hover:bg-red-500/90 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
})
