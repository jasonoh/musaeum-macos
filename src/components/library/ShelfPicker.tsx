import { useEffect, useState } from 'react'
import type { ShelfSummary } from '@shared/shelf.types'
import { useNASStore } from '@/stores/nas.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { useUIStore } from '@/stores/ui.store'
import { CheckIcon, PlusIcon, SpinnerIcon } from '@/components/shared/icons'
import { useDialogFocus } from '@/hooks/useDialogFocus'
import { addToShelf, removeFromShelf } from '@/lib/shelf-membership'
import { reportShelfFailure } from '@/lib/shelf-feedback'

/**
 * *Add to Shelf…* (D9, AC19) — a dialog rather than a flyout submenu (R2), so
 * Escape, Tab containment and first focus come from `useDialogFocus` instead of
 * hand-rolled hover intent.
 *
 * For **one** book the shelves it is already on carry a check and choosing one
 * takes it off (with Undo); for a **selection** there is nothing to tick — the
 * shelves are actions, and the click adds every book of the scope. *New Shelf…*
 * creates with the scope's books and closes: the shelf exists, the sidebar shows
 * it, and nothing else about the view changes.
 *
 * The checks come from `forBook`, which is per book and cached in the shelves
 * store; `revision` is what makes them re-ask when membership moves.
 *
 * Its write is `addToShelf`/`removeFromShelf` (not the bridge directly), so the
 * toast, the Undo and the once-a-session failure report are the same here as at
 * the five other surfaces.
 */
export function ShelfPicker() {
  const dialogRef = useDialogFocus()
  const target = useUIStore((s) => s.shelfPicker)
  const requestShelfPicker = useUIStore((s) => s.requestShelfPicker)
  const shelves = useShelvesStore((s) => s.shelves)
  const revision = useShelvesStore((s) => s.revision)
  const byBook = useShelvesStore((s) => s.byBook)
  const loadForBook = useShelvesStore((s) => s.loadForBook)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const label = useNASStore((s) => s.status?.copy.label ?? undefined)

  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const bookIds = target?.bookIds ?? []
  const one = bookIds.length === 1 ? bookIds[0] : null

  useEffect(() => {
    if (one) void loadForBook(one)
  }, [one, revision, loadForBook])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestShelfPicker(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestShelfPicker])

  if (!target) return null

  const on = new Set(one ? (byBook[one] ?? []).map((s) => s.id) : [])

  const act = async (shelf: ShelfSummary) => {
    if (!online || busy) return
    setBusy(shelf.id)
    try {
      if (on.has(shelf.id)) await removeFromShelf(shelf, bookIds)
      else await addToShelf(shelf, bookIds)
    } finally {
      setBusy(null)
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setCreating(false)
      return
    }
    try {
      await window.Musaeum.shelves.create(trimmed, bookIds)
      requestShelfPicker(null)
    } catch (err) {
      reportShelfFailure(err)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
      onClick={() => requestShelfPicker(null)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Add to Shelf"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
      >
        <h2 className="font-display text-lg leading-snug text-parchment">Add to Shelf</h2>
        <p className="mt-0.5 text-[12px] text-parchment-faint">
          {bookIds.length} book{bookIds.length === 1 ? '' : 's'}
        </p>

        <div className="mt-4 max-h-72 space-y-0.5 overflow-y-auto">
          {shelves.map((shelf) => (
            <button
              key={shelf.id}
              disabled={!online || busy !== null}
              title={online ? undefined : label}
              onClick={() => void act(shelf)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="w-4">
                {busy === shelf.id ? (
                  <SpinnerIcon className="h-3.5 w-3.5" />
                ) : on.has(shelf.id) ? (
                  <CheckIcon className="h-3.5 w-3.5 text-gold-400" />
                ) : null}
              </span>
              <span className="truncate">{shelf.name}</span>
              <span className="ml-auto text-[11px] tabular-nums text-parchment-faint">
                {shelf.count}
              </span>
            </button>
          ))}

          {creating ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
                if (e.key === 'Escape') setCreating(false)
              }}
              onBlur={() => setCreating(false)}
              maxLength={80}
              placeholder="Shelf name"
              aria-label="Shelf name"
              className="w-full rounded-md border border-gold-500/60 bg-ink-850 px-2 py-1.5 text-[13px] text-parchment placeholder:text-parchment-faint focus:border-gold-500"
            />
          ) : (
            <button
              disabled={!online}
              title={online ? undefined : label}
              onClick={() => {
                setName('')
                setCreating(true)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40"
            >
              <span className="w-4">
                <PlusIcon className="h-3.5 w-3.5" />
              </span>
              New Shelf…
            </button>
          )}
        </div>

        <div className="mt-5 flex justify-end">
          <button
            data-autofocus
            onClick={() => requestShelfPicker(null)}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
