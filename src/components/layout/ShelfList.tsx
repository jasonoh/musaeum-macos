import { useEffect, useState } from 'react'
import type { ShelfSummary } from '@shared/shelf.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/shared/icons'
import { BOOK_DRAG_MIME, dragPayload } from '@/lib/book-drag'
import { reportShelfFailure } from '@/lib/shelf-feedback'
import { addToShelf } from '@/lib/shelf-membership'
import { useDialogFocus } from '@/hooks/useDialogFocus'

/** Which row's name is being typed. Local: it is about this column, not the app. */
type Editing = { mode: 'create' } | { mode: 'rename'; id: string } | null

/**
 * The Shelves section of the sidebar (D9).
 *
 * Three things about its shape are deliberate:
 *
 * - **Its writes are attempted, not synced.** Nothing here updates the list
 *   after a create, rename or delete: main broadcasts `shelves:changed` and
 *   `useLibrary` re-reads, so the sidebar cannot show a shelf the share refused
 *   to write. The cost is one round trip of latency after Enter; the benefit is
 *   one source of truth.
 * - **A refusal keeps the field open, with the text in it.** Main's sentence
 *   says what was wrong with the name (empty, too long, already taken); a field
 *   that closed on refusal would make the user type it again to find out.
 * - **The confirmation is local.** Exactly one surface opens it, so it does not
 *   belong in `ui.store` beside the dialogs that five surfaces share (R8).
 *
 * Its create/rename/delete call `window.Musaeum.shelves.*` directly rather than
 * through a `src/lib` module: they are single-surface actions with no shared
 * vocabulary to drift from, unlike the add/remove pair five surfaces perform.
 * Their failures still go through `reportShelfFailure`.
 *
 * The `name` field is local state and no effect in this file writes it, so a
 * `shelves:changed` arriving mid-rename cannot clobber what is being typed
 * (Review Focus 3).
 *
 * Slice 3 landed: the rows are drop targets, and the **+** and the empty-state
 * row create with the dragged books (the drop's ids ride `pending`, so a field
 * abandoned with Escape takes nothing with it — S4). Slice 4 adds *Send to
 * ‹device›* above *Delete Shelf…* and is not stubbed here.
 */
export function ShelfList() {
  const dialogRef = useDialogFocus()
  const shelves = useShelvesStore((s) => s.shelves)
  const activeShelfId = useLibraryStore((s) => s.activeShelfId)
  const setActiveShelf = useLibraryStore((s) => s.setActiveShelf)
  const online = useNASStore((s) => s.status?.state === 'connected')
  const label = useNASStore((s) => s.status?.copy.label ?? undefined)
  const deleteBlocked = useNASStore((s) => s.status?.copy.deleteBlocked ?? undefined)

  const [editing, setEditing] = useState<Editing>(null)
  const [name, setName] = useState('')
  const [menu, setMenu] = useState<{ shelf: ShelfSummary; x: number; y: number } | null>(null)
  const [confirming, setConfirming] = useState<ShelfSummary | null>(null)
  /** The row (or `'create'`) the pointer is over mid-drag; set by dragover, cleared by drop/leave. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** The books a create control was dropped with: outlives the drag, dies with the field (S4). */
  const [pending, setPending] = useState<string[] | null>(null)

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null)
    const onScroll = () => setMenu(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScroll)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  const startCreate = (ids: string[] | null = null) => {
    setName('')
    setPending(ids)
    setEditing({ mode: 'create' })
    setMenu(null)
  }

  const startRename = (shelf: ShelfSummary) => {
    setName(shelf.name)
    // A rename abandons any create field that was open, and the books that field
    // was holding go with it (S4): they were only ever the field's.
    setPending(null)
    setEditing({ mode: 'rename', id: shelf.id })
    setMenu(null)
  }

  /**
   * Whether a drag in flight is one of ours. The test is on the *event's* types,
   * not on the slot alone (S1): after a drag the window never saw end — Escape,
   * or a release over another app, with the source unmounted mid-drag so no
   * `dragend` reaches the window — the slot can still hold the previous drag's
   * ids, and a Finder file drop must not be answered from them.
   */
  const isBookDrag = (e: React.DragEvent): boolean =>
    [...(e.dataTransfer?.types ?? [])].includes(BOOK_DRAG_MIME)

  /**
   * Whether a drag in flight may land on this row.
   *
   * Refused — no ring, and a refusal `dropEffect`, which is what turns the
   * cursor into a "no" — when the drag is not a book drag, when nothing is
   * being carried, when the share cannot take a write (AC28), and for the shelf
   * that is already open: the books in the payload are that shelf's own rows,
   * so "adding" them is a no-op and the toast would read *Already on To Read*
   * for the one gesture most likely to repeat (S3).
   */
  const canAcceptDrop = (e: React.DragEvent, shelfId: string): boolean => {
    const ids = dragPayload()
    return isBookDrag(e) && Boolean(ids?.length) && online && shelfId !== activeShelfId
  }

  const onRowDragOver = (e: React.DragEvent, shelf: ShelfSummary) => {
    // `dropEffect` has to be set on every dragover: Chromium resets it
    if (!e.dataTransfer) return
    if (!canAcceptDrop(e, shelf.id)) {
      e.dataTransfer.dropEffect = 'none'
      setDropTarget((t) => (t === shelf.id ? null : t))
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTarget(shelf.id)
  }

  const onRowDrop = async (e: React.DragEvent, shelfId: string) => {
    e.preventDefault()
    setDropTarget(null)
    if (!isBookDrag(e)) return
    const ids = dragPayload()
    if (!ids?.length || !online) return
    // The id, re-looked-up: `shelves:changed` can land between the ring
    // appearing and the drop, and a captured object would be the old shelf
    // (Review Focus 3)
    const shelf = useShelvesStore.getState().shelves.find((s) => s.id === shelfId)
    if (!shelf) return
    await addToShelf(shelf, [...ids])
  }

  /**
   * A drop on a create control (`+`, or the empty-state row) opens the name
   * field with the dragged books held in `pending`, not in the drag's slot: the
   * slot's lifetime is the drag and the field outlives it (S4). The same gate as
   * the rows — a foreign drag is refused, and (as measured) a refusal's
   * `dropEffect = 'none'` means the browser delivers no `drop` at all.
   */
  const onCreateDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer) return
    if (!isBookDrag(e) || !dragPayload()?.length || !online) {
      e.dataTransfer.dropEffect = 'none'
      setDropTarget((t) => (t === 'create' ? null : t))
      return
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropTarget('create')
  }

  /** An abandoned field takes the pending books with it — nothing was created (S4). */
  const onCreateDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDropTarget(null)
    if (!isBookDrag(e)) return
    const ids = dragPayload()
    if (!ids?.length || !online) return
    startCreate([...ids])
  }

  /**
   * Enter commits, Escape and blur cancel, and an empty name is a cancel rather
   * than a refusal: an abandoned field is not an error to report.
   */
  const commit = async () => {
    if (!editing) return
    const trimmed = name.trim()
    if (!trimmed) {
      setEditing(null)
      setPending(null)
      return
    }
    try {
      if (editing.mode === 'create')
        await window.Musaeum.shelves.create(trimmed, pending ?? undefined)
      else await window.Musaeum.shelves.rename(editing.id, trimmed)
      setEditing(null)
      setPending(null)
      // A create selects nothing: the new row appears and the view stays where
      // the user put it (the sheet's `+` does not jump either)
    } catch (err) {
      reportShelfFailure(err)
    }
  }

  const remove = async (shelf: ShelfSummary) => {
    setConfirming(null)
    try {
      await window.Musaeum.shelves.delete(shelf.id)
    } catch (err) {
      reportShelfFailure(err)
    }
  }

  return (
    <div className="mb-4 px-2">
      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="font-display text-[11px] uppercase tracking-wider text-parchment-faint">
          Shelves
        </span>
        <button
          onClick={() => startCreate()}
          onDragOver={onCreateDragOver}
          onDrop={(e) => onCreateDrop(e)}
          disabled={!online}
          title={online ? 'New shelf' : label}
          aria-label="New shelf"
          className={`ml-auto rounded p-0.5 text-parchment-faint transition-colors hover:text-gold-400 disabled:pointer-events-none disabled:opacity-40 ${
            dropTarget === 'create' ? 'ring-1 ring-gold-400 ring-inset' : ''
          }`}
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The empty state is a *control*, not an instruction. The spec's line here
          was "Drag books here to start a shelf" — and it is a drop target now
          (slice 3), so dropping books on it starts the shelf with them; the
          sentence stays out because the control teaches the rest. */}
      {shelves.length === 0 && !editing && (
        <button
          onClick={() => startCreate()}
          onDragOver={onCreateDragOver}
          onDrop={(e) => onCreateDrop(e)}
          disabled={!online}
          title={online ? 'New shelf' : label}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-parchment-faint transition-colors hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40 ${
            dropTarget === 'create' ? 'ring-1 ring-gold-400 ring-inset' : ''
          }`}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New shelf
        </button>
      )}

      {editing?.mode === 'create' && (
        <NameField
          value={name}
          onChange={setName}
          onCommit={commit}
          onCancel={() => {
            setEditing(null)
            setPending(null)
          }}
        />
      )}

      {shelves.map((shelf) => {
        const active = shelf.id === activeShelfId
        return (
          <div key={shelf.id}>
            {editing?.mode === 'rename' && editing.id === shelf.id ? (
              <NameField
                value={name}
                onChange={setName}
                onCommit={commit}
                onCancel={() => {
                  setEditing(null)
                  setPending(null)
                }}
              />
            ) : (
              <button
                onClick={() => setActiveShelf(shelf.id)}
                onDragOver={(e) => onRowDragOver(e, shelf)}
                onDragLeave={() => setDropTarget((t) => (t === shelf.id ? null : t))}
                onDrop={(e) => void onRowDrop(e, shelf.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ shelf, x: e.clientX, y: e.clientY })
                }}
                onDoubleClick={() => startRename(shelf)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ring-inset ${
                  dropTarget === shelf.id ? 'ring-1 ring-gold-400' : ''
                } ${
                  active
                    ? 'bg-ink-800 font-medium text-parchment'
                    : 'text-parchment-dim hover:bg-ink-800 hover:text-parchment'
                }`}
              >
                <span className="truncate">{shelf.name}</span>
                <span className="ml-auto text-[11px] tabular-nums text-parchment-faint">
                  {shelf.count}
                </span>
              </button>
            )}
          </div>
        )
      })}

      {menu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setMenu(null)}
          onContextMenu={() => setMenu(null)}
        >
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            style={{ left: menu.x, top: menu.y }}
            className="absolute w-44 animate-fade-in overflow-hidden rounded-lg border border-ink-700 bg-ink-850 py-1 shadow-cover-lift"
          >
            <button
              role="menuitem"
              disabled={!online}
              title={online ? undefined : label}
              onClick={() => startRename(menu.shelf)}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment disabled:pointer-events-none disabled:opacity-40"
            >
              <PencilIcon className="h-3.5 w-3.5" />
              Rename
            </button>
            {/* Slice 4's Send to ‹device› slots in here. */}
            <button
              role="menuitem"
              disabled={!online}
              title={deleteBlocked}
              onClick={() => {
                setConfirming(menu.shelf)
                setMenu(null)
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-parchment-dim hover:bg-danger-500/15 hover:text-danger-400 disabled:pointer-events-none disabled:opacity-40"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              Delete Shelf…
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/80 p-8 backdrop-blur-sm"
          onClick={() => setConfirming(null)}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`Delete the shelf ${confirming.name}`}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-cover-lift"
          >
            <h2 className="font-display text-lg leading-snug text-parchment">
              Delete the shelf “{confirming.name}”?
            </h2>
            <p className="mt-2 text-[12px] leading-relaxed text-parchment-dim">
              Its {confirming.count} books stay in your library.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                data-autofocus
                onClick={() => setConfirming(null)}
                className="rounded-md border border-ink-600 px-3 py-1.5 text-[13px] text-parchment-dim hover:bg-ink-800 hover:text-parchment"
              >
                Cancel
              </button>
              <button
                onClick={() => void remove(confirming)}
                className="flex items-center gap-2 rounded-md bg-danger-500 px-3 py-1.5 text-[13px] font-semibold text-on-danger hover:bg-danger-500/90"
              >
                <TrashIcon className="h-4 w-4" />
                Delete shelf
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The inline name field: Enter commits, Escape cancels, blur cancels, and the
 * field is what holds focus from the moment it opens, so `+` then a name then
 * Enter is one uninterrupted gesture.
 */
function NameField({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange(next: string): void
  onCommit(): void
  onCancel(): void
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void onCommit()
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={onCancel}
      maxLength={80}
      placeholder="Shelf name"
      aria-label="Shelf name"
      className="mb-0.5 w-full rounded-md border border-gold-500/60 bg-ink-850 px-2 py-1 text-[13px] text-parchment placeholder:text-parchment-faint focus:border-gold-500"
    />
  )
}
