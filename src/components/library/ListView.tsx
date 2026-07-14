import type { Book } from '@shared/book.types'
import { seriesDisplay } from '@shared/book.types'
import { useLibraryStore } from '@/stores/library.store'
import { useUIStore } from '@/stores/ui.store'
import { StarIcon } from '@/components/shared/icons'

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

  return (
    <tr
      onClick={() => selectBook(book.id)}
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

export function ListView() {
  const books = useLibraryStore((s) => s.books)

  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full table-fixed border-collapse">
        <thead className="sticky top-0 z-10 bg-ink-900">
          <tr className="border-b border-ink-700 text-left text-[11px] font-semibold uppercase tracking-wider text-parchment-faint">
            <th className="w-[30%] py-2 pl-6 pr-3">Title</th>
            <th className="w-[20%] px-3 py-2">Author</th>
            <th className="w-[18%] px-3 py-2">Series</th>
            <th className="w-[12%] px-3 py-2">Added</th>
            <th className="w-[10%] px-3 py-2">Formats</th>
            <th className="w-[10%] px-3 py-2 pr-6">Rating</th>
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
