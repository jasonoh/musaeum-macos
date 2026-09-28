import { useEffect, useState } from 'react'
import type { ShelfSummary } from '@shared/shelf.types'
import { useLibraryStore } from '@/stores/library.store'
import { useNASStore } from '@/stores/nas.store'
import { useShelvesStore } from '@/stores/shelves.store'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/shared/icons'
import { reportShelfFailure } from '@/lib/shelf-feedback'
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
 * Slice 4 adds *Send to ‹device›* above *Delete Shelf…*; slice 3 makes the rows
 * drop targets. Neither is stubbed here.
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

  const startCreate = () => {
    setName('')
    setEditing({ mode: 'create' })
    setMenu(null)
  }

  const startRename = (shelf: ShelfSummary) => {
    setName(shelf.name)
    setEditing({ mode: 'rename', id: shelf.id })
    setMenu(null)
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
      return
    }
    try {
      if (editing.mode === 'create') await window.Musaeum.shelves.create(trimmed)
      else await window.Musaeum.shelves.rename(editing.id, trimmed)
      setEditing(null)
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
          onClick={startCreate}
          disabled={!online}
          title={online ? 'New shelf' : label}
          aria-label="New shelf"
          className="ml-auto rounded p-0.5 text-parchment-faint transition-colors hover:text-gold-400 disabled:pointer-events-none disabled:opacity-40"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {shelves.length === 0 && !editing && (
        <p className="px-2 py-1 text-[12px] text-parchment-faint">
          Drag books here to start a shelf
        </p>
      )}

      {editing?.mode === 'create' && (
        <NameField
          value={name}
          onChange={setName}
          onCommit={commit}
          onCancel={() => setEditing(null)}
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
                onCancel={() => setEditing(null)}
              />
            ) : (
              <button
                onClick={() => setActiveShelf(shelf.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ shelf, x: e.clientX, y: e.clientY })
                }}
                onDoubleClick={() => startRename(shelf)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
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
