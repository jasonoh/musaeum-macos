import { useEffect, useState } from 'react'
import { useShelvesStore } from '@/stores/shelves.store'
import { useUIStore } from '@/stores/ui.store'
import { TrashIcon } from '@/components/shared/icons'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { removeFromShelf } from '@/lib/shelf-membership'

/**
 * The trash entry points' first question while a shelf is open (D9, AC21).
 *
 * Inside a shelf, "delete" is ambiguous: it can mean *off the shelf* (the thing
 * the user is looking at) or *out of the library* (irreversible). This asks, and
 * keeps both answers honest — Remove is immediate and carries the Undo; Delete
 * from Library… hands over to `DeleteBookDialog`/`DeleteSelectionDialog`, which
 * stay the only place anything is deleted, per-format picker and offline notice
 * included.
 *
 * Its primary action takes the initial focus, which inverts the usual rule
 * (`useDialogFocus` puts `data-autofocus` on Cancel for a destructive dialog):
 * here the irreversible button is the *other* one.
 *
 * It closes itself if the shelf it was opened for disappears from the list —
 * the same posture `RemoveFromDeviceDialog` takes to a device that has been
 * unplugged.
 */
export function ShelfRemoveDialog() {
  const dialogRef = useDialogFocus()
  const target = useUIStore((s) => s.shelfRemove)
  const requestShelfRemove = useUIStore((s) => s.requestShelfRemove)
  const requestLibraryDelete = useUIStore((s) => s.requestLibraryDelete)
  const shelves = useShelvesStore((s) => s.shelves)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestShelfRemove(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestShelfRemove])

  // A shelf deleted while this dialog is open closes it rather than failing on
  // confirm
  const shelf = shelves.find((s) => s.id === target?.shelfId)
  if (!target || !shelf) return null

  const count = target.bookIds.length
  const what = count === 1 ? `${count} book` : `${count} books`

  const remove = async () => {
    setBusy(true)
    await removeFromShelf(shelf, target.bookIds)
    setBusy(false)
    requestShelfRemove(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => !busy && requestShelfRemove(null)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Remove from ${shelf.name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">
          Remove {what} from “{shelf.name}”?
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-parchment-dim">
          They stay in your library, and you can undo this.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          {/* The irreversible one, set apart — and deliberately not focused */}
          <button
            disabled={busy}
            onClick={requestLibraryDelete}
            className="flex items-center gap-2 rounded-md border border-danger-500/40 px-3 py-1.5 text-[13px] text-danger-400 hover:bg-danger-500/15 disabled:opacity-40"
          >
            <TrashIcon className="h-4 w-4" />
            Delete from Library…
          </button>
          <button
            data-autofocus
            disabled={busy}
            onClick={() => void remove()}
            className="rounded-md bg-gold-500 px-3 py-1.5 text-[13px] font-semibold text-ink-950 hover:bg-gold-400 disabled:opacity-40"
          >
            Remove from Shelf
          </button>
        </div>
      </div>
    </div>
  )
}
