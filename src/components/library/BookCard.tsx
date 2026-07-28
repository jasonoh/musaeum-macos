import { memo } from 'react'
import type { Book } from '@shared/book.types'
import { seriesDisplay } from '@shared/book.types'
import { bookOnDevices, useDeviceStore } from '@/stores/device.store'
import { useUIStore } from '@/stores/ui.store'
import { DeviceIcon } from '@/components/shared/icons'

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
  const selectBook = useUIStore((s) => s.selectBook)
  const selected = useUIStore((s) => s.selectedBookId === book.id)
  const thumb = coverUrl(book, 'thumb')
  const onDevice = useDeviceStore((s) => bookOnDevices(s, book.id).length > 0)

  return (
    <button
      onClick={() => selectBook(book.id)}
      className="group flex w-full flex-col text-left focus-visible:ring-2 focus-visible:ring-gold-400/70 rounded-md"
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

      <div className="mt-2 min-h-[3rem] px-0.5">
        <p className="line-clamp-2 font-display text-[13px] leading-tight text-parchment group-hover:text-gold-300">
          {book.title}
        </p>
        {book.author && (
          <p className="mt-0.5 truncate text-[11px] text-parchment-faint">{book.author}</p>
        )}
        {book.seriesName && (
          <p className="mt-0.5 truncate text-[11px] italic text-gold-400/70">
            {seriesDisplay(book.seriesName, book.seriesIndex)}
          </p>
        )}
      </div>
    </button>
  )
})
