import { useEffect, useMemo, useState } from 'react'
import type { BookFormat } from '@shared/book.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { selectedBookId, useUIStore } from '@/stores/ui.store'
import { CheckIcon, SpinnerIcon, TrashIcon } from '@/components/shared/icons'

/**
 * Confirmation for destructive deletes. Multi-format books get a per-format
 * picker; selecting every format (the default) deletes the whole book, which
 * is what the main process does with a full selection too.
 */
export function DeleteBookDialog() {
  const bookId = useUIStore((s) => s.deletingBookId)
  const requestDelete = useUIStore((s) => s.requestDelete)
  const selectBook = useUIStore((s) => s.selectBook)
  const currentSelection = useUIStore(selectedBookId)
  const books = useLibraryStore((s) => s.books)
  const status = useNASStore((s) => s.status)
  // The write gate's own question, unchanged (six surfaces ask it, and slice 2's
  // annex keeps them asking it) — the notice *beside* the disabled button is the
  // main process's sentence for this state (D4), not a second ternary over
  // `NASState` written here.
  const online = status?.state === 'connected'
  const blocked = status?.copy.deleteBlocked ?? null

  const book = useMemo(() => books.find((b) => b.id === bookId) ?? null, [books, bookId])
  // Mounted under a per-book key, so this initializer re-runs for each book:
  // everything selected, i.e. "delete the book" unless the user narrows it
  const [chosen, setChosen] = useState<Set<BookFormat>>(
    () => new Set(books.find((b) => b.id === bookId)?.formats ?? [])
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestDelete(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestDelete])

  if (!book) return null

  const multi = book.formats.length > 1
  // Guard against a concurrent library reload dropping a format out from under
  // the selection — only formats the book still has can be deleted
  const selected = book.formats.filter((f) => chosen.has(f))
  const wholeBook = selected.length === book.formats.length
  const nothingChosen = selected.length === 0

  const toggle = (format: BookFormat) => {
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(format)) next.delete(format)
      else next.add(format)
      return next
    })
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      if (wholeBook) {
        await window.Musaeum.library.deleteBook(book.id)
        if (currentSelection === book.id) selectBook(null)
      } else {
        await window.Musaeum.library.deleteFormats(book.id, selected)
      }
      requestDelete(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && requestDelete(null)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${book.title}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">Delete “{book.title}”?</h2>
        {book.author && <p className="mt-0.5 text-[13px] text-parchment-faint">{book.author}</p>}

        {multi && (
          <div className="mt-4 space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-parchment-faint">
              Formats to delete
            </p>
            {book.formats.map((f) => {
              const on = chosen.has(f)
              return (
                <button
                  key={f}
                  onClick={() => toggle(f)}
                  className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left text-[13px] transition-colors ${
                    on
                      ? 'border-danger-500/60 bg-danger-500/10 text-parchment'
                      : 'border-ink-700 text-parchment-dim hover:border-ink-600 hover:bg-ink-850'
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                      on ? 'border-danger-400 bg-danger-500/30 text-danger-400' : 'border-ink-600'
                    }`}
                  >
                    {on && <CheckIcon className="h-3 w-3" />}
                  </span>
                  <span className="uppercase tracking-wider">{f}</span>
                </button>
              )
            })}
            <button
              onClick={() => setChosen(wholeBook ? new Set<BookFormat>() : new Set(book.formats))}
              className="pt-0.5 text-[11px] text-parchment-faint underline-offset-2 hover:text-gold-300 hover:underline"
            >
              {wholeBook ? 'Clear selection' : 'Select all formats'}
            </button>
          </div>
        )}

        <p className="mt-4 text-[12px] leading-relaxed text-parchment-dim">
          {wholeBook ? (
            <>
              This permanently removes the book, all {multi ? 'its files' : 'of its files'}, covers,
              and metadata from the library. This can’t be undone.
            </>
          ) : (
            <>
              This permanently deletes the selected file
              {selected.length > 1 ? 's' : ''} from the library folder. The book and its remaining
              formats stay in the library.
            </>
          )}
        </p>

        {blocked && <p className="mt-3 text-[12px] text-danger-400">{blocked}</p>}
        {error && <p className="mt-3 text-[12px] text-danger-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => requestDelete(null)}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            disabled={busy || !online || nothingChosen}
            onClick={() => void confirm()}
            className="flex items-center gap-2 rounded-md bg-danger-500 px-3 py-1.5 text-[13px] font-semibold text-on-danger hover:bg-danger-500/90 disabled:opacity-40"
          >
            {busy ? <SpinnerIcon className="h-4 w-4" /> : <TrashIcon className="h-4 w-4" />}
            {wholeBook
              ? 'Delete book'
              : `Delete ${selected.length} format${selected.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
