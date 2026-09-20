import { useUIStore } from '@/stores/ui.store'
import { BookIcon } from '@/components/shared/icons'
import { importBooksFromDialog } from '@/lib/add-books'
import type { LibraryViewState } from '@/lib/library-emptiness'

/**
 * The library's empty pane, shared by the grid and the list.
 *
 * This is the app's only first-run surface, and it is load-bearing: there is no
 * File menu import and no toolbar control for getting books in, so for a new
 * user this screen *is* the on-ramp. It used to be grid-only (`ListView` drew a
 * sticky header over a blank pane at zero books, and list mode is a persisted
 * preference), and it used to offer drag-and-drop only — never Calibre, in an
 * app whose reason to exist is replacing it.
 *
 * 'loading' renders nothing: a cold start reports zero books for as long as the
 * first load takes, and the first-run copy is a lie until it resolves.
 */
export function EmptyLibrary({ state, query }: { state: LibraryViewState; query: string }) {
  const openModal = useUIStore((s) => s.openModal)

  if (state === 'loading' || state === 'books') return null

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-parchment-faint">
      <BookIcon className="h-10 w-10" />

      {state === 'no-matches' ? (
        <>
          <p className="text-sm">Nothing matches “{query.trim()}”</p>
          <p className="max-w-xs text-[12px]">
            Clear the search or the filters to see the library again
          </p>
        </>
      ) : (
        <>
          <p className="font-display text-lg text-parchment-dim">Your library awaits</p>
          <p className="max-w-sm text-sm">
            Drag EPUB, MOBI, AZW3 or PDF files anywhere in this window — or bring in a library you
            already have.
          </p>
          <div className="mt-1 flex items-center gap-2">
            {/* The same two doors, in the same order, as the Add Books menu —
                one habit covers both surfaces. The picker leads because it is
                the generic path; the wizard is the bigger commitment, and it is
                not first-run-only: the PDF top-up inside it is meant to be run
                again later. */}
            <button
              onClick={() => void importBooksFromDialog()}
              className="rounded-md bg-gold-500 px-3 py-1.5 text-[13px] font-semibold text-ink-950 hover:bg-gold-400"
            >
              Import files…
            </button>
            <button
              onClick={() => openModal('migration')}
              className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
            >
              Migrate from Calibre…
            </button>
          </div>
        </>
      )}
    </div>
  )
}
