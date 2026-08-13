import { useCallback, useEffect, useRef } from 'react'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import { useLibraryStore } from '@/stores/library.store'
import { useReaderStore } from '@/stores/reader.store'
import { ReaderEngine } from './ReaderEngine'
import { ReaderToc } from './ReaderToc'
import { CloseIcon, ListIcon } from '@/components/shared/icons'

/** Position reports are debounced: a page turn is cheap, a NAS write is not. */
const REPORT_DEBOUNCE_MS = 2_000

export function ReaderView() {
  const bookId = useReaderStore((s) => s.bookId)
  const format = useReaderStore((s) => s.format)
  const status = useReaderStore((s) => s.status)
  const error = useReaderStore((s) => s.error)
  const percent = useReaderStore((s) => s.percent)
  const tocOpen = useReaderStore((s) => s.tocOpen)
  const prefs = useReaderStore((s) => s.prefs)
  const close = useReaderStore((s) => s.close)
  const setStatus = useReaderStore((s) => s.setStatus)
  const setToc = useReaderStore((s) => s.setToc)
  const setPercent = useReaderStore((s) => s.setPercent)
  const toggleToc = useReaderStore((s) => s.toggleToc)

  const books = useLibraryStore((s) => s.books)
  const book = books.find((b) => b.id === bookId) ?? null

  const viewRef = useRef<FoliateView | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<{ position: string | null; percent: number } | null>(null)

  const flush = useCallback(
    (final: boolean) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const report = latest.current
      if (!report || !bookId) return
      void window.Musaeum.reader.saveProgress({ bookId, ...report, final }).catch(() => {})
      if (final) {
        latest.current = null
        // Nothing broadcasts libraryChanged for a progress write, so the
        // cached Book still holds the position this session started from —
        // and reopening would resume there instead of here.
        void useLibraryStore.getState().load()
      }
    },
    [bookId]
  )

  const onRelocate = useCallback(
    (detail: { position: string | null; percent: number }) => {
      latest.current = detail
      setPercent(detail.percent)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => flush(false), REPORT_DEBOUNCE_MS)
    },
    [flush, setPercent]
  )

  const closeReader = useCallback(() => {
    flush(true)
    close()
  }, [flush, close])

  /**
   * Shared by the overlay's window listener and every section document the
   * engine loads — the book's iframe takes focus as soon as a page renders,
   * so window alone would only work until the first click.
   */
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          closeReader()
          break
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          void viewRef.current?.next()
          break
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          void viewRef.current?.prev()
          break
      }
    },
    [closeReader]
  )

  useEffect(() => {
    if (!bookId) return
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bookId, onKeyDown])

  // A close that skips the button — window closing, book deleted — still reports
  useEffect(() => () => flush(true), [flush])

  if (!bookId || !format || !book) return null

  return (
    <div className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-ink-950">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-ink-800 bg-ink-900 px-3">
        <button
          onClick={closeReader}
          title="Close reader (Esc)"
          aria-label="Close reader"
          className="rounded p-1.5 text-parchment-faint hover:bg-ink-800 hover:text-parchment"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
        <button
          onClick={toggleToc}
          title="Table of contents"
          aria-label="Table of contents"
          aria-pressed={tocOpen}
          className={`rounded p-1.5 hover:bg-ink-800 hover:text-parchment ${
            tocOpen ? 'text-gold-300' : 'text-parchment-faint'
          }`}
        >
          <ListIcon className="h-4 w-4" />
        </button>

        <div className="mx-3 min-w-0 flex-1 text-center">
          <h1 className="truncate font-display text-[15px] leading-tight text-parchment">
            {book.title}
          </h1>
          {book.author && (
            <p className="truncate text-[11px] leading-tight text-parchment-faint">{book.author}</p>
          )}
        </div>

        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-parchment-faint">
          {status === 'ready' ? `${Math.round(percent * 100)}%` : ''}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {tocOpen && <ReaderToc onNavigate={(href) => void viewRef.current?.goTo(href)} />}
        <main className="relative min-w-0 flex-1">
          {status === 'error' ? (
            <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
              <p className="max-w-md text-[13px] leading-relaxed text-parchment-dim">{error}</p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    void window.Musaeum.files.openBookFile(book.id, format).catch(() => {})
                    closeReader()
                  }}
                  className="rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-parchment-dim hover:border-gold-500/50 hover:text-gold-300"
                >
                  Open externally
                </button>
                <button
                  onClick={closeReader}
                  className="rounded-md border border-ink-600 px-3 py-1.5 text-[12px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              {status === 'loading' && (
                <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-[13px] italic text-parchment-faint">
                  Opening…
                </p>
              )}
              <ReaderEngine
                bookId={book.id}
                format={format}
                initial={book.readingState}
                prefs={prefs}
                viewRef={viewRef}
                onReady={(toc) => {
                  setToc(toc)
                  setStatus('ready')
                }}
                onRelocate={onRelocate}
                onError={(message) => setStatus('error', message)}
                onKeyDown={onKeyDown}
              />
            </>
          )}
        </main>
      </div>

      <div className="h-0.5 shrink-0 bg-ink-800">
        <div
          className="h-full bg-gold-500 transition-[width] duration-200"
          style={{ width: `${Math.min(100, Math.max(0, percent * 100))}%` }}
        />
      </div>
    </div>
  )
}
