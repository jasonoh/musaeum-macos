import { useLibraryStore } from '@/stores/library.store'
import { BookCard } from './BookCard'
import { BookIcon } from '@/components/shared/icons'

export function GridView() {
  const books = useLibraryStore((s) => s.books)
  const query = useLibraryStore((s) => s.query)

  if (!books.length) {
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

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-5 gap-y-6">
        {books.map((book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </div>
    </div>
  )
}
