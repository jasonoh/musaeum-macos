import { useCallback, useEffect, useRef } from 'react'
import type { FoliateView } from '@vendor/foliate-js/view.js'
import { TITLEBAR_STRIP_HEIGHT, TRAFFIC_LIGHT_RIGHT_EDGE } from '@shared/window-chrome'
import { isTypingTarget } from '@/hooks/useBookNavigation'
import { useLibraryStore } from '@/stores/library.store'
import { useReaderStore } from '@/stores/reader.store'
import { useUIStore } from '@/stores/ui.store'
import { ReaderEngine } from './ReaderEngine'
import { ReaderPrefsPopover } from './ReaderPrefsPopover'
import { ReaderAsk } from './ReaderAsk'
import { ReaderSearch } from './ReaderSearch'
import { ReaderToc } from './ReaderToc'
import { AskIcon, CloseIcon, ListIcon, SearchIcon } from '@/components/shared/icons'

/** Position reports are debounced: a page turn is cheap, a NAS write is not. */
const REPORT_DEBOUNCE_MS = 2_000

/**
 * What the header's controls clear, in px: the traffic lights' group plus one
 * `px-3` of breathing room.
 *
 * The reader is an overlay across the whole window, so while a book is open this
 * header *is* the titlebar — and the dots paint over whatever sits in the first
 * 74px, which is where the close, contents, search and ask controls used to
 * start. The width comes from `@shared/window-chrome`, the one place the dots'
 * geometry lives (the window's own `trafficLightPosition` and the sidebar's
 * wordmark read the same constant), never a copied number.
 *
 * The space is spent on a spacer rather than on the header's own padding, so it
 * can also give the window back its drag handle: every other top strip in the
 * app is draggable, and the overlay had covered the only one there was. The
 * spacer holds no control, so it cannot swallow a click meant for one.
 */
const TRAFFIC_LIGHT_INSET = TRAFFIC_LIGHT_RIGHT_EDGE + 12

export function ReaderView() {
  const bookId = useReaderStore((s) => s.bookId)
  const format = useReaderStore((s) => s.format)
  const status = useReaderStore((s) => s.status)
  const error = useReaderStore((s) => s.error)
  const percent = useReaderStore((s) => s.percent)
  const tocOpen = useReaderStore((s) => s.tocOpen)
  const prefsOpen = useReaderStore((s) => s.prefsOpen)
  const prefs = useReaderStore((s) => s.prefs)
  const askOpen = useReaderStore((s) => s.askOpen)
  const searchOpen = useReaderStore((s) => s.searchOpen)
  const query = useReaderStore((s) => s.query)
  const close = useReaderStore((s) => s.close)
  const setStatus = useReaderStore((s) => s.setStatus)
  const setToc = useReaderStore((s) => s.setToc)
  const setPercent = useReaderStore((s) => s.setPercent)
  const setSection = useReaderStore((s) => s.setSection)
  const setSectionLabel = useReaderStore((s) => s.setSectionLabel)
  const setSelection = useReaderStore((s) => s.setSelection)
  const toggleToc = useReaderStore((s) => s.toggleToc)
  const toggleAsk = useReaderStore((s) => s.toggleAsk)
  const toggleSearch = useReaderStore((s) => s.toggleSearch)
  const closeSearch = useReaderStore((s) => s.closeSearch)
  const clearSearch = useReaderStore((s) => s.clearSearch)
  const togglePrefs = useReaderStore((s) => s.togglePrefs)
  const closePrefs = useReaderStore((s) => s.closePrefs)

  const books = useLibraryStore((s) => s.books)
  const book = books.find((b) => b.id === bookId) ?? null

  // Modals and dialogs render *after* the reader in App.tsx at the same z-50,
  // so they sit on top of an open book and own the keyboard while they do.
  const modal = useUIStore((s) => s.modal)
  const contextMenu = useUIStore((s) => s.contextMenu)
  const deletingBookId = useUIStore((s) => s.deletingBookId)
  const editingBookId = useUIStore((s) => s.editingBookId)
  const removingFromDevice = useUIStore((s) => s.removingFromDevice)
  const overlaid =
    modal !== null ||
    contextMenu !== null ||
    deletingBookId !== null ||
    editingBookId !== null ||
    removingFromDevice !== null

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
    (detail: { position: string | null; percent: number; label: string | null }) => {
      // Only the two fields the report carries: `latest` is spread straight
      // into `saveProgress`, so anything else here would ride along.
      latest.current = { position: detail.position, percent: detail.percent }
      setPercent(detail.percent)
      setSectionLabel(detail.label)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => flush(false), REPORT_DEBOUNCE_MS)
    },
    [flush, setPercent, setSectionLabel]
  )

  const closeReader = useCallback(() => {
    flush(true)
    close()
  }, [flush, close])

  /**
   * Shared by the overlay's window listener and every section document the
   * engine loads — the book's iframe takes focus as soon as a page renders,
   * so window alone would only work until the first click.
   *
   * It bails for whatever is on top of the reader the same way
   * `useBookNavigation` bails for whatever is on top of the library — the
   * inverse of that guard, and needed just as much: ⌘, over an open book
   * paints Settings above it, and without this a space typed into one of its
   * fields would turn the page underneath while Escape closed both at once.
   */
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (overlaid || isTypingTarget(e.target)) return
      // The typography panel is the reader's own rather than something painted
      // over it, so Escape dismisses the panel instead of taking the book with
      // it — and while it is open it owns every other key, so Space can't both
      // press one of its buttons and turn the page underneath.
      if (prefsOpen) {
        if (e.key !== 'Escape') return
        e.preventDefault()
        closePrefs()
        return
      }
      // The search panel is the reader's own too, and Escape steps back out the
      // way the reader came in: results, then the panel, then the book (AC1.6).
      //
      // Only Escape is intercepted here. Every other key is left to the switch
      // below, because the panel already owns the keys *while focus is inside
      // it* — its own handler stops them there, and `isTypingTarget` bails for
      // the query box above — whereas swallowing them here would kill page turns
      // for as long as the panel is open, which is not what a find bar does
      // (AC1.2). Measured: with this arm taking every unmodified key, an arrow
      // key did nothing while the panel stood.
      if (searchOpen && e.key === 'Escape') {
        e.preventDefault()
        if (query.trim()) clearSearch()
        else closeSearch()
        return
      }
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
    [closeReader, closePrefs, clearSearch, closeSearch, overlaid, prefsOpen, searchOpen, query]
  )

  useEffect(() => {
    if (!bookId) return
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bookId, onKeyDown])

  /**
   * A book deleted while it is open takes the reader with it. The pending
   * report is dropped rather than flushed: the book has no folder left to
   * write metadata.json into, and how far someone got through a deleted book
   * is moot. Without this the overlay unmounts on its own (no `book` to
   * render) but `bookId` stays set, so the debounce fires into the void.
   */
  useEffect(() => {
    if (!bookId || book) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    latest.current = null
    close()
  }, [bookId, book, close])

  // A close that skips the button — the window closing, a switch to another
  // book — still reports
  useEffect(() => () => flush(true), [flush])

  if (!bookId || !format || !book) return null

  // The reader gets a layer of its own, between the library and the modals:
  // above all library chrome (ImportOverlay's drop target is z-40, its
  // progress toasts z-30) and below every modal, dialog and context menu
  // (all z-50), so a modal opened over an open book always paints on top.
  // Sharing z-50 would leave that to tie-break on mount order in App.tsx —
  // correct today, and silently broken by anyone who reorders it.
  return (
    <div className="fixed inset-0 z-[45] flex animate-fade-in flex-col bg-ink-950">
      <header
        className="flex shrink-0 items-center gap-1 border-b border-ink-800 bg-ink-900 pr-3"
        // The strip's height is derived from the lights' line rather than chosen:
        // this header *is* the window's titlebar while a book is open, and its
        // controls have to sit level with the dots behind the spacer below
        // (`TITLEBAR_STRIP_HEIGHT`). `h-11` centred the row 4px above them.
        style={{ height: TITLEBAR_STRIP_HEIGHT }}
      >
        {/* The dots' strip, and the window's drag handle while a book is open —
            see TRAFFIC_LIGHT_INSET. Empty by design: nothing here but the
            traffic lights macOS paints over it. */}
        <div
          className="app-drag h-full shrink-0"
          style={{ width: TRAFFIC_LIGHT_INSET }}
          aria-hidden
        />
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
        <button
          onClick={toggleSearch}
          title="Find in this book (⌘F)"
          aria-label="Find in this book"
          aria-pressed={searchOpen}
          className={`rounded p-1.5 hover:bg-ink-800 hover:text-parchment ${
            searchOpen ? 'text-gold-300' : 'text-parchment-faint'
          }`}
        >
          <SearchIcon className="h-4 w-4" />
        </button>
        <button
          onClick={toggleAsk}
          title="Ask about this book"
          aria-label="Ask about this book"
          aria-pressed={askOpen}
          className={`rounded p-1.5 hover:bg-ink-800 hover:text-parchment ${
            askOpen ? 'text-gold-300' : 'text-parchment-faint'
          }`}
        >
          <AskIcon className="h-4 w-4" />
        </button>

        <div className="mx-3 min-w-0 flex-1 text-center">
          <h1 className="truncate font-display text-[15px] leading-tight text-parchment">
            {book.title}
          </h1>
          {book.author && (
            <p className="truncate text-[11px] leading-tight text-parchment-faint">{book.author}</p>
          )}
        </div>

        <button
          onClick={togglePrefs}
          title="Typography"
          aria-label="Typography"
          aria-expanded={prefsOpen}
          className={`rounded px-1.5 py-1 hover:bg-ink-800 hover:text-parchment ${
            prefsOpen ? 'text-gold-300' : 'text-parchment-faint'
          }`}
        >
          <span className="font-display text-[15px] leading-4">Aa</span>
        </button>
        <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-parchment-faint">
          {status === 'ready' ? `${Math.round(percent * 100)}%` : ''}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* One side slot (D4): whichever panel is open, and only one is */}
        {tocOpen && <ReaderToc onNavigate={(href) => void viewRef.current?.goTo(href)} />}
        {searchOpen && <ReaderSearch viewRef={viewRef} />}
        {askOpen && <ReaderAsk onNavigate={(href) => void viewRef.current?.goTo(href)} />}
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
                onSection={setSection}
                onSelection={setSelection}
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

      {prefsOpen && <ReaderPrefsPopover onClose={closePrefs} />}
    </div>
  )
}
